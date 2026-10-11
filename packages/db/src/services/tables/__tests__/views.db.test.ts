/**
 * Saved views (Phase 0 slice V) against real PostgreSQL, rolled back per test:
 * `normalizeViewConfig` through `createView` / `updateView` — every key checked
 * against the schema the author can read, unknown keys dropped, the keys of the
 * view's own type required, other types' keys kept only while valid, the saved
 * query dry-compiled — plus type changes and `deleteView` privacy.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetProvider,
  initDatabase,
  TablesValidationError,
  type CreateTableFieldInput,
  type DatabaseProvider,
  type TableFieldRow,
  type UserRow,
} from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { fullTableAccess, type TableAccessScope, type TableDataScope } from '@greenhouse/types/table-access';
import type { TableViewConfig, TableViewType } from '@greenhouse/types/tables';
import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let mate: UserRow;

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  [owner, mate] = await Promise.all([
    createInternalTestUser(db, { email: `tables-v-owner-${tag}@test.local`, nickname: 'Views Owner' }),
    createInternalTestUser(db, { email: `tables-v-mate-${tag}@test.local`, nickname: 'Views Mate' }),
  ]);
});

afterEach(() => {
  _resetProvider();
});

async function workspace() {
  const base = await db.tables.createBase({ name: 'Views', owner_id: owner.id, created_by: owner.id });
  const schema = await db.tables.createTable({ base_id: base.id, name: 'Deals', created_by: owner.id });
  const tableId = schema.table.id;
  const field = (
    name: string,
    type: TableFieldRow['type'],
    extra: Partial<Pick<CreateTableFieldInput, 'config'>> = {},
  ) => db.tables.createField({ table_id: tableId, name, type, created_by: owner.id, ...extra });
  const primary = schema.fields[0]!;
  const stage = await field('Stage', 'single_select', {
    config: {
      options: [
        { id: 'lead', label: 'Lead' },
        { id: 'won', label: 'Won' },
      ],
    },
  });
  const assignee = await field('Assignee', 'user');
  const due = await field('Due', 'date');
  const ends = await field('Ends', 'datetime');
  const photos = await field('Photos', 'attachment');
  const amount = await field('Amount', 'number');
  const notes = await field('Notes', 'long_text');
  return { base, tableId, primary, stage, assignee, due, ends, photos, amount, notes };
}

type Workspace = Awaited<ReturnType<typeof workspace>>;

function create(
  ws: Workspace,
  type: TableViewType | undefined,
  config: unknown,
  scope: TableAccessScope = fullTableAccess(owner.id),
) {
  return db.tables.createView(
    {
      table_id: ws.tableId,
      name: `${type ?? 'grid'} view`,
      type,
      config: config as TableViewConfig,
      created_by: owner.id,
    },
    scope,
  );
}

const configOf = (view: { config: string }) => JSON.parse(view.config) as TableViewConfig & Record<string, unknown>;

describe('normalizeViewConfig (through createView / updateView)', () => {
  it('honours the type and rebuilds the config from known keys only', async () => {
    const ws = await workspace();
    const view = await create(ws, 'kanban', {
      kanban: {
        groupFieldId: ws.stage.id,
        coverFieldId: ws.photos.id,
        hiddenGroups: ['won', '', 'deleted-option'],
        x: 1,
      },
      fieldIds: [ws.amount.id, ws.primary.id, ws.amount.id, 999_999],
      systemFields: ['created_by', 'created_at', 'created_by'],
      widths: { [String(ws.amount.id)]: 5000, created_at: 10, '999999': 120 },
      rowHeight: 'tall',
      query: {
        where: { combinator: 'and', clauses: [{ fieldId: ws.stage.id, operator: 'eq', value: 'lead', junk: true }] },
        sort: [{ systemField: 'created_at', direction: 'desc' }],
        cursor: 'nope',
        limit: 10,
      },
      somethingElse: { nested: true },
    });
    expect(view.type).toBe('kanban');
    expect(configOf(view)).toEqual({
      version: 1,
      fieldIds: [ws.amount.id, ws.primary.id],
      systemFields: ['created_by', 'created_at'],
      widths: { [String(ws.amount.id)]: 1600, created_at: 40 },
      rowHeight: 'tall',
      query: {
        where: { combinator: 'and', clauses: [{ fieldId: ws.stage.id, operator: 'eq', value: 'lead' }] },
        sort: [{ systemField: 'created_at', direction: 'desc' }],
      },
      kanban: { groupFieldId: ws.stage.id, coverFieldId: ws.photos.id, hiddenGroups: ['won', ''] },
    });
  });

  it('requires the keys of the view’s own type, with a field of the right type', async () => {
    const ws = await workspace();
    await expect(create(ws, 'kanban', {})).rejects.toThrow(/single-select or person/);
    await expect(create(ws, 'kanban', { kanban: { groupFieldId: ws.amount.id } })).rejects.toThrow(
      /kanban\.groupFieldId/,
    );
    await expect(
      create(ws, 'kanban', { kanban: { groupFieldId: ws.stage.id, coverFieldId: ws.notes.id } }),
    ).rejects.toThrow(/coverFieldId/);
    await expect(create(ws, 'calendar', {})).rejects.toThrow(/date field/);
    await expect(create(ws, 'calendar', { calendar: { startFieldId: ws.primary.id } })).rejects.toThrow(
      TablesValidationError,
    );
    await expect(
      create(ws, 'calendar', { calendar: { startFieldId: ws.due.id, endFieldId: ws.due.id } }),
    ).rejects.toThrow(/must differ/);
    await expect(create(ws, 'gallery', { gallery: { coverFieldId: ws.amount.id } })).rejects.toThrow(/coverFieldId/);
    await expect(create(ws, 'gallery', { gallery: { fit: 'stretch' } })).rejects.toThrow(/fit/);
    await expect(create(ws, 'grid', { groupBy: { fieldId: ws.notes.id } })).rejects.toThrow(/groupBy/);
    await expect(create(ws, 'grid', { rowHeight: 'huge' })).rejects.toThrow(/rowHeight/);
    await expect(create(ws, 'grid', { systemFields: ['owner'] })).rejects.toThrow(/systemFields/);
    await expect(create(ws, 'grid', { frozenCount: -1 })).rejects.toThrow(/frozenCount/);
    await expect(create(ws, 'grid', { fieldIds: 'all' })).rejects.toThrow(/fieldIds/);
    await expect(create(ws, 'map' as TableViewType, {})).rejects.toThrow(/View type/);

    const user = await create(ws, 'kanban', { kanban: { groupFieldId: ws.assignee.id, hiddenGroups: [mate.id] } });
    expect(configOf(user).kanban).toEqual({ groupFieldId: ws.assignee.id, hiddenGroups: [mate.id] });
    const calendar = await create(ws, 'calendar', { calendar: { startFieldId: ws.due.id, endFieldId: ws.ends.id } });
    expect(configOf(calendar).calendar).toEqual({ startFieldId: ws.due.id, endFieldId: ws.ends.id });
    const gallery = await create(ws, 'gallery', { gallery: { coverFieldId: ws.photos.id, fit: 'contain' } });
    expect(configOf(gallery).gallery).toEqual({ coverFieldId: ws.photos.id, fit: 'contain' });
  });

  it('dry-compiles the saved query with the one compiler', async () => {
    const ws = await workspace();
    await expect(
      create(ws, 'grid', {
        query: { where: { combinator: 'and', clauses: [{ fieldId: 999_999, operator: 'eq', value: 1 }] } },
      }),
    ).rejects.toThrow(/unavailable/);
    await expect(
      create(ws, 'grid', {
        query: { where: { combinator: 'and', clauses: [{ fieldId: ws.amount.id, operator: 'contains', value: 1 }] } },
      }),
    ).rejects.toThrow(/not supported/);
    await expect(
      create(ws, 'grid', {
        query: { where: { combinator: 'and', clauses: [{ fieldId: ws.stage.id, operator: 'eq', value: 'nope' }] } },
      }),
    ).rejects.toThrow(TablesValidationError);
    await expect(
      create(ws, 'grid', {
        query: { sort: [1, 2, 3, 4].map(() => ({ fieldId: ws.amount.id, direction: 'asc' })) },
      }),
    ).rejects.toThrow(/sort supports at most/);

    // Tokens and system fields are as valid here as in a record query; an empty where is dropped.
    const view = await create(ws, 'grid', {
      query: {
        where: { combinator: 'and', clauses: [{ systemField: 'created_by', operator: 'eq', value: '$me' }] },
        filters: [
          { combinator: 'or', clauses: [{ fieldId: ws.due.id, operator: 'gte', value: '$today-7d' }] },
          { combinator: 'and', clauses: [] },
        ],
        search: '',
      },
    });
    expect(configOf(view).query).toEqual({
      where: { combinator: 'and', clauses: [{ systemField: 'created_by', operator: 'eq', value: '$me' }] },
      filters: [{ combinator: 'or', clauses: [{ fieldId: ws.due.id, operator: 'gte', value: '$today-7d' }] }],
    });
    const empty = await create(ws, 'grid', { query: { where: { combinator: 'and', clauses: [] } } });
    expect(configOf(empty).query).toBeUndefined();
  });

  it('keeps grid grouping in config.groupBy, moving one written into the query', async () => {
    const ws = await workspace();
    const moved = await create(ws, 'grid', { query: { groupBy: { fieldId: ws.stage.id, direction: 'desc' } } });
    expect(configOf(moved)).toEqual({ version: 1, groupBy: { fieldId: ws.stage.id, direction: 'desc' } });
    const system = await create(ws, 'grid', { groupBy: { systemField: 'created_by' } });
    expect(configOf(system).groupBy).toEqual({ systemField: 'created_by' });
  });

  it('keeps another type’s settings while valid and drops them once stale', async () => {
    const ws = await workspace();
    const view = await create(ws, 'grid', {
      kanban: { groupFieldId: ws.stage.id },
      calendar: { startFieldId: ws.primary.id },
      gallery: { coverFieldId: ws.notes.id },
      groupBy: { fieldId: ws.stage.id },
    });
    // The kanban lanes survive on a grid (so switching back keeps them); the broken calendar / gallery do not.
    expect(configOf(view)).toEqual({
      version: 1,
      groupBy: { fieldId: ws.stage.id },
      kanban: { groupFieldId: ws.stage.id },
    });

    // updateView may change the type: the stored config is re-validated for it.
    const asKanban = await db.tables.updateView(
      view.id,
      { revision: view.revision, type: 'kanban' },
      undefined,
      fullTableAccess(owner.id),
    );
    expect(asKanban.ok).toBe(true);
    if (!asKanban.ok) return;
    expect(asKanban.value.type).toBe('kanban');
    // A grid grouping is kept on a kanban only while it is valid; it still is.
    expect(configOf(asKanban.value).kanban).toEqual({ groupFieldId: ws.stage.id });

    await expect(
      db.tables.updateView(
        view.id,
        { revision: asKanban.value.revision, type: 'calendar' },
        undefined,
        fullTableAccess(owner.id),
      ),
    ).rejects.toThrow(/date field/);

    // Archiving the lane field makes a kanban config stale: display lists shrink
    // silently, but the type's own key must be fixed before the next config write.
    await db.tables.archiveField(ws.stage.id, owner.id);
    const renamed = await db.tables.updateView(
      view.id,
      { revision: asKanban.value.revision, name: 'Renamed' },
      undefined,
      fullTableAccess(owner.id),
    );
    expect(renamed).toMatchObject({ ok: true, value: { name: 'Renamed' } });
    if (!renamed.ok) return;
    await expect(
      db.tables.updateView(
        view.id,
        { revision: renamed.value.revision, config: configOf(renamed.value) },
        undefined,
        fullTableAccess(owner.id),
      ),
    ).rejects.toThrow(/kanban\.groupFieldId/);
  });

  it('limits a scoped author to the fields it can read', async () => {
    const ws = await workspace();
    const scope: TableDataScope = {
      kind: 'scoped',
      userId: mate.id,
      tableId: ws.tableId,
      rows: [{ type: 'all' }],
      editRows: [],
      readableFieldIds: [ws.primary.id, ws.stage.id, ws.due.id],
      editableFieldIds: [],
      canCreate: false,
      canDelete: false,
    };
    const view = await create(
      ws,
      'grid',
      { fieldIds: [ws.primary.id, ws.amount.id, ws.stage.id], widths: { [String(ws.amount.id)]: 200 } },
      scope,
    );
    // A hidden field drops out of display lists, as if it did not exist…
    expect(configOf(view)).toEqual({ version: 1, fieldIds: [ws.primary.id, ws.stage.id] });
    // …and is refused wherever it would shape the view.
    await expect(create(ws, 'grid', { groupBy: { fieldId: ws.amount.id } }, scope)).rejects.toThrow(/groupBy/);
    await expect(create(ws, 'kanban', { kanban: { groupFieldId: ws.assignee.id } }, scope)).rejects.toThrow(
      /kanban\.groupFieldId/,
    );
    await expect(
      create(
        ws,
        'grid',
        { query: { where: { combinator: 'and', clauses: [{ fieldId: ws.amount.id, operator: 'gt', value: 1 }] } } },
        scope,
      ),
    ).rejects.toThrow(/unavailable/);
    await expect(create(ws, 'calendar', { calendar: { startFieldId: ws.due.id } }, scope)).resolves.toMatchObject({
      type: 'calendar',
    });
  });

  it('appends new views after the last one', async () => {
    const ws = await workspace();
    const first = await create(ws, 'grid', {});
    const second = await create(ws, 'grid', {});
    expect(second.position).toBeGreaterThan(first.position);
  });
});

describe('deleteView', () => {
  it('hard-deletes a visible view and never someone else’s personal one', async () => {
    const ws = await workspace();
    const shared = await create(ws, 'grid', {});
    const personal = await db.tables.createView(
      { table_id: ws.tableId, name: 'Mine', scope: 'personal', owner_id: mate.id, created_by: mate.id },
      fullTableAccess(mate.id),
    );

    expect(await db.tables.deleteView(personal.id, owner.id)).toBeUndefined();
    expect(await db.tables.getView(personal.id, mate.id)).toBeDefined();

    expect(await db.tables.deleteView(personal.id, mate.id)).toMatchObject({ id: personal.id });
    expect(await db.tables.getView(personal.id)).toBeUndefined();
    expect(await db.tables.deleteView(shared.id, mate.id)).toMatchObject({ id: shared.id });
    expect(await db.tables.listViews(ws.tableId, owner.id)).not.toContainEqual(
      expect.objectContaining({ id: shared.id }),
    );
  });
});
