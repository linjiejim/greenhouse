/**
 * Tables foundation (Phase 0 slice F) against real PostgreSQL, rolled back per
 * test: the one SQL compiler (system fields, `$me` / date tokens in a time
 * zone, filters[], groupBy, fail-closed row scopes, readable-field rejection,
 * search), scoped writes, aggregates with date buckets and series, and
 * `onRecordWritten` history inside the write transaction.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  _resetProvider,
  initDatabase,
  TablesValidationError,
  type CreateTableFieldInput,
  type DatabaseProvider,
  type TableFieldRow,
  type TableRecordRow,
  type UserRow,
} from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { fullTableAccess, type TableDataScope, type TableRowScope } from '@greenhouse/types/table-access';
import type { TableQuery, TableRecordWriteMeta } from '@greenhouse/types/tables';
import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let mate: UserRow;

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  [owner, mate] = await Promise.all([
    createInternalTestUser(db, { email: `tables-f-owner-${tag}@test.local`, nickname: 'Foundation Owner' }),
    createInternalTestUser(db, { email: `tables-f-mate-${tag}@test.local`, nickname: 'Foundation Mate' }),
  ]);
});

afterEach(() => {
  _resetProvider();
});

const full = (userId: string | null) => fullTableAccess(userId);
const meta = (actorId: string, extra: Partial<TableRecordWriteMeta> = {}): TableRecordWriteMeta => ({
  actorId,
  actorKind: 'user',
  enqueueAutomations: true,
  ...extra,
});
const scoped = (tableId: number, userId: string, overrides: Partial<TableDataScope> = {}): TableDataScope => ({
  kind: 'scoped',
  userId,
  tableId,
  rows: [],
  editRows: [],
  readableFieldIds: [],
  editableFieldIds: [],
  canCreate: true,
  canDelete: true,
  ...overrides,
});

/** A, B straddle midnight in Asia/Shanghai (UTC+8) but share one UTC day. */
const AT_A = '2026-03-10T15:30:00.000Z';
const AT_B = '2026-03-10T17:00:00.000Z';
const NOW = new Date('2026-03-11T02:00:00.000Z');

async function workspace() {
  const base = await db.tables.createBase({ name: 'Foundation', owner_id: owner.id, created_by: owner.id });
  const schema = await db.tables.createTable({ base_id: base.id, name: 'Requests', created_by: owner.id });
  const tableId = schema.table.id;
  const field = (
    name: string,
    type: TableFieldRow['type'],
    extra: Partial<Pick<CreateTableFieldInput, 'config' | 'required'>> = {},
  ) => db.tables.createField({ table_id: tableId, name, type, created_by: owner.id, ...extra });
  const primary = schema.fields[0]!;
  const status = await field('Status', 'single_select', {
    config: {
      options: [
        { id: 'todo', label: 'To do' },
        { id: 'done', label: 'Done' },
      ],
    },
  });
  const score = await field('Score', 'number');
  const assignee = await field('Assignee', 'user');
  const due = await field('Due', 'date');
  const at = await field('At', 'datetime');
  const secret = await field('Secret', 'text');
  const create = (actor: UserRow, values: Record<number, unknown>) =>
    db.tables.createRecord(
      { table_id: tableId, values: Object.fromEntries(Object.entries(values)) },
      full(actor.id),
      meta(actor.id),
    );
  const a = await create(owner, {
    [primary.id]: 'Alpha',
    [status.id]: 'todo',
    [score.id]: 8,
    [assignee.id]: mate.id,
    [due.id]: '2026-03-10',
    [at.id]: AT_A,
    [secret.id]: 'needle in a haystack',
  });
  const b = await create(mate, {
    [primary.id]: 'Bravo asks $me later',
    [status.id]: 'done',
    [score.id]: 3,
    [due.id]: '2026-03-11',
    [at.id]: AT_B,
  });
  const c = await create(owner, { [primary.id]: 'Charlie', [status.id]: 'todo', [score.id]: 1 });
  return { base, tableId, primary, status, score, assignee, due, at, secret, a, b, c };
}

const ids = (records: TableRecordRow[]) => records.map((record) => record.id).sort((x, y) => x - y);

async function queryIds(
  tableId: number,
  query: TableQuery,
  scope: ReturnType<typeof full> | TableDataScope,
  evaluation?: { now?: Date; timeZone?: string },
) {
  return ids((await db.tables.queryRecords(tableId, { limit: 500, ...query }, scope, evaluation)).records);
}

describe('Tables SQL compiler', () => {
  it('filters, sorts and groups by system fields, with $me from the scope user', async () => {
    const w = await workspace();
    const createdByMe: TableQuery = {
      where: { combinator: 'and', clauses: [{ systemField: 'created_by', operator: 'eq', value: '$me' }] },
    };
    expect(await queryIds(w.tableId, createdByMe, full(mate.id))).toEqual([w.b.id]);
    expect(await queryIds(w.tableId, createdByMe, full(owner.id))).toEqual(ids([w.a, w.c]));
    // No acting user: `$me` matches nothing (and `neq $me` everything).
    expect(await queryIds(w.tableId, createdByMe, full(null))).toEqual([]);
    expect(
      await queryIds(
        w.tableId,
        { where: { combinator: 'and', clauses: [{ systemField: 'updated_by', operator: 'neq', value: '$me' }] } },
        full(null),
      ),
    ).toEqual(ids([w.a, w.b, w.c]));
    expect(
      await queryIds(
        w.tableId,
        { where: { combinator: 'and', clauses: [{ systemField: 'created_by', operator: 'in', value: [mate.id] }] } },
        full(owner.id),
      ),
    ).toEqual([w.b.id]);
    // created_at is "today" for rows written just now.
    expect(
      await queryIds(
        w.tableId,
        { where: { combinator: 'and', clauses: [{ systemField: 'created_at', operator: 'eq', value: '$today' }] } },
        full(owner.id),
      ),
    ).toEqual(ids([w.a, w.b, w.c]));
    expect(
      await queryIds(
        w.tableId,
        { where: { combinator: 'and', clauses: [{ systemField: 'created_at', operator: 'gt', value: '$today' }] } },
        full(owner.id),
      ),
    ).toEqual([]);

    const bySystem = await db.tables.queryRecords(
      w.tableId,
      { sort: [{ systemField: 'created_by', direction: 'asc' }], groupBy: { systemField: 'created_by' } },
      full(owner.id),
    );
    expect(bySystem.total).toBe(3);
  });

  it('resolves $me only on person clauses and date tokens only on date clauses, in the evaluation zone', async () => {
    const w = await workspace();
    const where = (clause: Record<string, unknown>): TableQuery => ({
      where: { combinator: 'and', clauses: [clause as never] },
    });
    expect(
      await queryIds(w.tableId, where({ fieldId: w.assignee.id, operator: 'eq', value: '$me' }), full(mate.id)),
    ).toEqual([w.a.id]);
    expect(
      await queryIds(w.tableId, where({ fieldId: w.assignee.id, operator: 'eq', value: '$me' }), full(owner.id)),
    ).toEqual([]);
    // On a text field `$me` is just text.
    expect(
      await queryIds(w.tableId, where({ fieldId: w.primary.id, operator: 'contains', value: '$me' }), full(mate.id)),
    ).toEqual([w.b.id]);
    expect(
      await queryIds(w.tableId, where({ fieldId: w.primary.id, operator: 'contains', value: '$today' }), full(mate.id)),
    ).toEqual([]);

    const utc = { now: NOW, timeZone: 'UTC' };
    const shanghai = { now: NOW, timeZone: 'Asia/Shanghai' };
    // datetime: a day token means that whole local day.
    expect(
      await queryIds(w.tableId, where({ fieldId: w.at.id, operator: 'eq', value: '$today' }), full(owner.id), utc),
    ).toEqual([]);
    expect(
      await queryIds(w.tableId, where({ fieldId: w.at.id, operator: 'eq', value: '$today-1d' }), full(owner.id), utc),
    ).toEqual(ids([w.a, w.b]));
    expect(
      await queryIds(w.tableId, where({ fieldId: w.at.id, operator: 'eq', value: '$today' }), full(owner.id), shanghai),
    ).toEqual([w.b.id]);
    expect(
      await queryIds(
        w.tableId,
        where({ fieldId: w.at.id, operator: 'eq', value: '$yesterday' }),
        full(owner.id),
        shanghai,
      ),
    ).toEqual([w.a.id]);
    expect(
      await queryIds(
        w.tableId,
        where({ fieldId: w.at.id, operator: 'lte', value: '2026-03-10' }),
        full(owner.id),
        shanghai,
      ),
    ).toEqual([w.a.id]);
    expect(
      await queryIds(w.tableId, where({ fieldId: w.at.id, operator: 'lt', value: '$now' }), full(owner.id), utc),
    ).toEqual(ids([w.a, w.b]));
    expect(
      await queryIds(w.tableId, where({ fieldId: w.at.id, operator: 'gt', value: '$now' }), full(owner.id), utc),
    ).toEqual([]);
    // date: tokens become calendar days.
    expect(
      await queryIds(
        w.tableId,
        where({ fieldId: w.due.id, operator: 'eq', value: '$today' }),
        full(owner.id),
        shanghai,
      ),
    ).toEqual([w.b.id]);
    expect(
      await queryIds(w.tableId, where({ fieldId: w.due.id, operator: 'lt', value: '$today' }), full(owner.id), utc),
    ).toEqual([w.a.id]);
  });

  it('ANDs filters[] with where, orders groupBy before sorts without counting it, and binds cursors to the query', async () => {
    const w = await workspace();
    const filtered = await queryIds(
      w.tableId,
      {
        where: { combinator: 'and', clauses: [{ fieldId: w.status.id, operator: 'eq', value: 'todo' }] },
        filters: [{ combinator: 'and', clauses: [{ fieldId: w.score.id, operator: 'gt', value: 5 }] }],
      },
      full(owner.id),
    );
    expect(filtered).toEqual([w.a.id]);
    const sixGroups = Array.from({ length: 6 }, () => ({ combinator: 'and' as const, clauses: [] }));
    await expect(db.tables.queryRecords(w.tableId, { filters: sixGroups }, full(owner.id))).rejects.toBeInstanceOf(
      TablesValidationError,
    );

    const grouped = await db.tables.queryRecords(
      w.tableId,
      {
        groupBy: { fieldId: w.status.id, direction: 'asc' },
        sort: [
          { fieldId: w.score.id, direction: 'desc' },
          { systemField: 'created_at', direction: 'asc' },
          { systemField: 'updated_by', direction: 'asc' },
        ],
      },
      full(owner.id),
    );
    expect(grouped.records.map((record) => record.id)).toEqual([w.b.id, w.a.id, w.c.id]);

    const page = await db.tables.queryRecords(
      w.tableId,
      {
        filters: [{ combinator: 'and', clauses: [{ fieldId: w.status.id, operator: 'eq', value: 'todo' }] }],
        limit: 1,
      },
      full(owner.id),
    );
    expect(page.nextCursor).toEqual(expect.any(String));
    await expect(
      db.tables.queryRecords(w.tableId, { limit: 1, cursor: page.nextCursor! }, full(owner.id)),
    ).rejects.toThrow(/cursor is invalid/);
    await expect(
      db.tables.queryRecords(
        w.tableId,
        {
          filters: [{ combinator: 'and', clauses: [{ fieldId: w.status.id, operator: 'eq', value: 'todo' }] }],
          limit: 1,
          cursor: page.nextCursor!,
        },
        full(mate.id),
      ),
    ).rejects.toThrow(/cursor is invalid/);
  });

  it('compiles row scopes fail-closed: dangling, wrong-type and empty predicates match nothing', async () => {
    const w = await workspace();
    const region = await db.tables.createField({
      table_id: w.tableId,
      name: 'Region',
      type: 'text',
      created_by: owner.id,
    });
    await db.tables.archiveField(region.id, owner.id);
    const readable = [w.primary.id, w.status.id, w.score.id];
    const rowsOf = (rows: TableRowScope[], userId = mate.id) =>
      queryIds(w.tableId, {}, scoped(w.tableId, userId, { rows, readableFieldIds: readable }));

    expect(await rowsOf([{ type: 'all' }])).toEqual(ids([w.a, w.b, w.c]));
    expect(
      await rowsOf([
        { type: 'where', where: { combinator: 'and', clauses: [{ fieldId: region.id, operator: 'eq', value: 'x' }] } },
      ]),
    ).toEqual([]);
    // OR: only the dangling branch drops out.
    expect(
      await rowsOf([
        {
          type: 'where',
          where: {
            combinator: 'or',
            clauses: [
              { fieldId: region.id, operator: 'eq', value: 'x' },
              { fieldId: w.status.id, operator: 'eq', value: 'done' },
            ],
          },
        },
      ]),
    ).toEqual([w.b.id]);
    expect(await rowsOf([{ type: 'where', where: { combinator: 'and', clauses: [] } }])).toEqual([]);
    expect(await rowsOf([{ type: 'related', creator: true, fieldIds: [] }])).toEqual([w.b.id]);
    // A person field the role cannot read still scopes its rows.
    expect(await rowsOf([{ type: 'related', creator: false, fieldIds: [w.assignee.id] }])).toEqual([w.a.id]);
    expect(await rowsOf([{ type: 'related', creator: false, fieldIds: [w.primary.id, region.id] }])).toEqual([]);
    expect(
      await rowsOf([
        { type: 'related', creator: true, fieldIds: [] },
        {
          type: 'where',
          where: { combinator: 'and', clauses: [{ fieldId: w.status.id, operator: 'eq', value: 'todo' }] },
        },
      ]),
    ).toEqual([]);
    expect(await rowsOf([{ type: 'bogus' } as unknown as TableRowScope])).toEqual([]);

    const mine = scoped(w.tableId, mate.id, {
      rows: [{ type: 'related', creator: true, fieldIds: [] }],
      readableFieldIds: readable,
    });
    expect(await db.tables.getRecord(w.tableId, w.a.id, mine)).toBeUndefined();
    expect((await db.tables.getRecord(w.tableId, w.b.id, mine))?.id).toBe(w.b.id);
    // A scope for one table never reads another.
    await expect(db.tables.queryRecords(w.tableId + 100_000, {}, mine)).rejects.toThrow(/scope/);
  });

  it('rejects unreadable fields anywhere a scoped reader references them, and searches readable text only', async () => {
    const w = await workspace();
    const reader = scoped(w.tableId, mate.id, { readableFieldIds: [w.primary.id, w.status.id] });
    const notReadable = { code: 'field_not_readable' };
    const scoreClause = { fieldId: w.score.id, operator: 'gt' as const, value: 1 };
    await expect(
      db.tables.queryRecords(w.tableId, { where: { combinator: 'and', clauses: [scoreClause] } }, reader),
    ).rejects.toMatchObject(notReadable);
    await expect(
      db.tables.queryRecords(w.tableId, { filters: [{ combinator: 'and', clauses: [scoreClause] }] }, reader),
    ).rejects.toMatchObject(notReadable);
    await expect(
      db.tables.queryRecords(w.tableId, { sort: [{ fieldId: w.score.id, direction: 'asc' }] }, reader),
    ).rejects.toMatchObject(notReadable);
    await expect(db.tables.queryRecords(w.tableId, { groupBy: { fieldId: w.score.id } }, reader)).rejects.toMatchObject(
      notReadable,
    );
    await expect(
      db.tables.aggregateRecords(w.tableId, { operation: 'sum', valueFieldId: w.score.id }, reader),
    ).rejects.toMatchObject(notReadable);
    await expect(
      db.tables.aggregateRecords(w.tableId, { operation: 'count', groupBy: { fieldId: w.score.id } }, reader),
    ).rejects.toMatchObject(notReadable);
    await expect(
      db.tables.aggregateRecords(
        w.tableId,
        { operation: 'count', groupBy: { fieldId: w.status.id }, series: { fieldId: w.score.id } },
        reader,
      ),
    ).rejects.toMatchObject(notReadable);
    await expect(
      db.tables.aggregateRecords(w.tableId, { operation: 'count', groupByFieldId: w.score.id }, reader),
    ).rejects.toMatchObject(notReadable);

    expect((await db.tables.queryRecords(w.tableId, { search: 'needle' }, full(owner.id))).total).toBe(1);
    expect((await db.tables.queryRecords(w.tableId, { search: 'needle' }, reader)).total).toBe(0);
    expect((await db.tables.queryRecords(w.tableId, { search: 'Alpha' }, reader)).total).toBe(1);
    // Readable fields and system fields stay usable.
    expect(
      await queryIds(
        w.tableId,
        { where: { combinator: 'and', clauses: [{ systemField: 'created_by', operator: 'eq', value: '$me' }] } },
        reader,
      ),
    ).toEqual([w.b.id]);
  });
});

describe('Scoped record writes', () => {
  it('enforces editable keys, create / delete rights, edit rows and D3 required fields', async () => {
    const w = await workspace();
    const priority = await db.tables.createField({
      table_id: w.tableId,
      name: 'Priority',
      type: 'number',
      required: true,
      created_by: owner.id,
    });
    const writer = scoped(w.tableId, mate.id, {
      rows: [{ type: 'all' }],
      editRows: [{ type: 'related', creator: true, fieldIds: [] }],
      readableFieldIds: [w.primary.id, w.status.id, w.score.id],
      editableFieldIds: [w.primary.id, w.status.id],
      canDelete: false,
    });
    await expect(
      db.tables.createRecord(
        { table_id: w.tableId, values: { [w.primary.id]: 'x', [w.score.id]: 2 } },
        writer,
        meta(mate.id),
      ),
    ).rejects.toMatchObject({ code: 'field_not_editable' });
    // Priority is required but not editable for this role: not enforced (D3).
    const created = await db.tables.createRecord(
      { table_id: w.tableId, values: { [w.primary.id]: 'Scoped create', [w.status.id]: 'todo' } },
      writer,
      meta(mate.id),
    );
    expect(created.created_by).toBe(mate.id);
    // …but a full-access writer is still held to it.
    await expect(
      db.tables.createRecord({ table_id: w.tableId, values: { [w.primary.id]: 'x' } }, full(owner.id), meta(owner.id)),
    ).rejects.toThrow(new RegExp(`"${priority.name}" is required`));
    await expect(
      db.tables.createRecord(
        { table_id: w.tableId, values: { [w.primary.id]: 'x' } },
        { ...writer, canCreate: false },
        meta(mate.id),
      ),
    ).rejects.toMatchObject({ code: 'create_forbidden' });

    // Readable but outside edit rows: indistinguishable from missing.
    expect(
      await db.tables.updateRecord(
        { table_id: w.tableId, record_id: w.a.id, revision: w.a.revision, values: { [w.status.id]: 'done' } },
        writer,
        meta(mate.id),
      ),
    ).toEqual({ ok: false, reason: 'not_found' });
    const updated = await db.tables.updateRecord(
      { table_id: w.tableId, record_id: w.b.id, revision: w.b.revision, values: { [w.status.id]: 'todo' } },
      writer,
      meta(mate.id),
    );
    expect(updated).toMatchObject({ ok: true, record: { revision: w.b.revision + 1 } });
    await expect(
      db.tables.deleteRecord({ table_id: w.tableId, record_id: w.b.id, revision: 2 }, writer, meta(mate.id)),
    ).rejects.toMatchObject({ code: 'delete_forbidden' });

    const deleter = { ...writer, canDelete: true };
    expect(
      await db.tables.deleteRecord({ table_id: w.tableId, record_id: w.c.id, revision: 1 }, deleter, meta(mate.id)),
    ).toEqual({ ok: false, reason: 'not_found' });
    expect(
      await db.tables.deleteRecord({ table_id: w.tableId, record_id: w.b.id, revision: 2 }, deleter, meta(mate.id)),
    ).toMatchObject({ ok: true });
    expect(ids(await db.tables.listDeletedRecords(w.tableId, deleter))).toEqual([w.b.id]);
    await expect(
      db.tables.restoreRecord({ table_id: w.tableId, record_id: w.b.id }, writer, meta(mate.id)),
    ).rejects.toMatchObject({ code: 'delete_forbidden' });
    expect(
      await db.tables.restoreRecord({ table_id: w.tableId, record_id: w.b.id }, deleter, meta(mate.id)),
    ).toMatchObject({ ok: true, record: { deleted_at: null } });

    const batch = await db.tables.validateBatchRecords(
      {
        table_id: w.tableId,
        items: [
          { values: { [w.primary.id]: 'ok' } },
          { values: { [w.primary.id]: 'no', [w.score.id]: 1 } },
          { record_id: w.a.id, revision: w.a.revision, values: { [w.status.id]: 'done' } },
        ],
      },
      writer,
    );
    expect(batch).toEqual([
      { index: 0, ok: true },
      expect.objectContaining({ index: 1, ok: false, reason: 'invalid' }),
      { index: 2, ok: false, reason: 'not_found' },
    ]);
  });

  it('refuses a lookup that does not read through a relation of its table (computation: tables-fx.db.test.ts)', async () => {
    const w = await workspace();
    await expect(
      db.tables.createField({
        table_id: w.tableId,
        name: 'Lookup',
        type: 'lookup',
        config: { lookup: { relationFieldId: w.primary.id, targetFieldId: w.primary.id } },
        created_by: owner.id,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('Aggregates', () => {
  it('buckets dates (in the viewer zone for instants), splits by series, and groups by system fields', async () => {
    const w = await workspace();
    const month = await db.tables.createTable({ base_id: w.base.id, name: 'Monthly', created_by: owner.id });
    const tableId = month.table.id;
    const day = await db.tables.createField({ table_id: tableId, name: 'Day', type: 'date', created_by: owner.id });
    const kind = await db.tables.createField({
      table_id: tableId,
      name: 'Kind',
      type: 'single_select',
      config: {
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
      },
      created_by: owner.id,
    });
    const amount = await db.tables.createField({
      table_id: tableId,
      name: 'Amount',
      type: 'number',
      created_by: owner.id,
    });
    for (const [date, k, value] of [
      ['2026-01-15', 'a', 10],
      ['2026-01-20', 'b', 5],
      ['2026-01-31', 'a', 1],
      ['2026-02-03', 'a', 7],
    ] as const) {
      await db.tables.createRecord(
        {
          table_id: tableId,
          values: { [month.fields[0]!.id]: date, [day.id]: date, [kind.id]: k, [amount.id]: value },
        },
        full(owner.id),
        meta(owner.id),
      );
    }
    expect(
      await db.tables.aggregateRecords(
        tableId,
        {
          operation: 'sum',
          valueFieldId: amount.id,
          groupBy: { fieldId: day.id, dateBucket: 'month' },
          series: { fieldId: kind.id },
          sort: 'group_asc',
        },
        full(owner.id),
      ),
    ).toEqual([
      { group: '2026-01-01', series: 'a', value: 11 },
      { group: '2026-01-01', series: 'b', value: 5 },
      { group: '2026-02-01', series: 'a', value: 7 },
    ]);
    // Top-N groups by value, then the series of those groups only.
    expect(
      await db.tables.aggregateRecords(
        tableId,
        {
          operation: 'sum',
          valueFieldId: amount.id,
          groupBy: { fieldId: day.id, dateBucket: 'month' },
          series: { fieldId: kind.id },
          limit: 1,
        },
        full(owner.id),
      ),
    ).toEqual([
      { group: '2026-01-01', series: 'a', value: 11 },
      { group: '2026-01-01', series: 'b', value: 5 },
    ]);

    const byDayUtc = await db.tables.aggregateRecords(
      w.tableId,
      {
        operation: 'count',
        groupBy: { fieldId: w.at.id, dateBucket: 'day' },
        query: { where: { combinator: 'and', clauses: [{ fieldId: w.at.id, operator: 'is_not_empty' }] } },
        sort: 'group_asc',
        timezone: 'UTC',
      },
      full(owner.id),
    );
    expect(byDayUtc).toEqual([{ group: '2026-03-10', value: 2 }]);
    const byDayShanghai = await db.tables.aggregateRecords(
      w.tableId,
      {
        operation: 'count',
        groupBy: { fieldId: w.at.id, dateBucket: 'day' },
        query: { where: { combinator: 'and', clauses: [{ fieldId: w.at.id, operator: 'is_not_empty' }] } },
        sort: 'group_asc',
        timezone: 'Asia/Shanghai',
      },
      full(owner.id),
    );
    expect(byDayShanghai).toEqual([
      { group: '2026-03-10', value: 1 },
      { group: '2026-03-11', value: 1 },
    ]);
    expect(
      await db.tables.aggregateRecords(
        w.tableId,
        { operation: 'count', groupBy: { systemField: 'created_by' } },
        full(owner.id),
      ),
    ).toEqual(
      expect.arrayContaining([
        { group: owner.id, value: 2 },
        { group: mate.id, value: 1 },
      ]),
    );
    await expect(
      db.tables.aggregateRecords(
        w.tableId,
        { operation: 'count', groupBy: { fieldId: w.score.id, dateBucket: 'month' } },
        full(owner.id),
      ),
    ).rejects.toThrow(/dateBucket requires a date/);
    await expect(
      db.tables.aggregateRecords(w.tableId, { operation: 'count', series: { fieldId: w.status.id } }, full(owner.id)),
    ).rejects.toThrow(/series requires groupBy/);
  });
});

describe('onRecordWritten', () => {
  async function formulaTable() {
    const base = await db.tables.createBase({ name: 'History', owner_id: owner.id, created_by: owner.id });
    const schema = await db.tables.createTable({ base_id: base.id, name: 'Items', created_by: owner.id });
    const effort = await db.tables.createField({
      table_id: schema.table.id,
      name: 'Effort',
      type: 'number',
      created_by: owner.id,
    });
    const doubled = await db.tables.createField({
      table_id: schema.table.id,
      name: 'Doubled',
      type: 'formula',
      config: {
        formula: {
          resultType: 'number',
          expression: {
            type: 'binary',
            operator: 'multiply',
            left: { type: 'field', fieldId: effort.id },
            right: { type: 'literal', value: 2 },
          },
        },
      },
      created_by: owner.id,
    });
    return { base, schema, tableId: schema.table.id, primary: schema.fields[0]!, effort, doubled };
  }

  it('records created / updated / deleted / restored with computed values from inside the write', async () => {
    const t = await formulaTable();
    const record = await db.tables.createRecord(
      { table_id: t.tableId, values: { [t.primary.id]: 'One', [t.effort.id]: 3 } },
      full(owner.id),
      meta(owner.id),
    );
    expect(record.computed_values[String(t.doubled.id)]).toBe(6);
    const updated = await db.tables.updateRecord(
      { table_id: t.tableId, record_id: record.id, revision: 1, values: { [t.effort.id]: 5 } },
      full(mate.id),
      meta(mate.id, { actorKind: 'agent' }),
    );
    expect(updated).toMatchObject({ ok: true, record: { computed_values: { [String(t.doubled.id)]: 10 } } });
    // Writing the same value again changes nothing → no history row.
    await db.tables.updateRecord(
      { table_id: t.tableId, record_id: record.id, revision: 2, values: { [t.effort.id]: 5 } },
      full(mate.id),
      meta(mate.id),
    );
    await db.tables.deleteRecord(
      { table_id: t.tableId, record_id: record.id, revision: 3 },
      full(owner.id),
      meta(owner.id),
    );
    await db.tables.restoreRecord({ table_id: t.tableId, record_id: record.id }, full(owner.id), meta(owner.id));

    const events = (await db.tables.listRecordEvents(record.id)).reverse();
    expect(events.map((event) => event.type)).toEqual(['created', 'updated', 'deleted', 'restored']);
    expect(events[0]).toMatchObject({ actor_id: owner.id, actor_kind: 'user', table_id: t.tableId });
    expect(events[0]!.changes).toEqual([
      { fieldId: t.primary.id, before: null, after: 'One' },
      { fieldId: t.effort.id, before: null, after: 3 },
      { fieldId: t.doubled.id, before: null, after: 6 },
    ]);
    expect(events[1]).toMatchObject({ actor_id: mate.id, actor_kind: 'agent' });
    expect(events[1]!.changes).toEqual([
      { fieldId: t.effort.id, before: 3, after: 5 },
      { fieldId: t.doubled.id, before: 6, after: 10 },
    ]);
    expect(events[2]!.changes).toEqual([]);
    const page = await db.tables.listRecordEvents(record.id, { limit: 2 });
    expect(page.map((event) => event.type)).toEqual(['restored', 'deleted']);
    const older = await db.tables.listRecordEvents(record.id, {
      before: { createdAt: page[1]!.created_at, id: page[1]!.id },
    });
    expect(older.map((event) => event.type)).toEqual(['updated', 'created']);
  });

  it('truncates long values and leaves rollup cascades out of history', async () => {
    const t = await formulaTable();
    const long = 'x'.repeat(5_000);
    const record = await db.tables.createRecord(
      { table_id: t.tableId, values: { [t.primary.id]: long } },
      full(owner.id),
      meta(owner.id),
    );
    const [created] = await db.tables.listRecordEvents(record.id);
    const after = created!.changes[0]!.after as string;
    expect(after.length).toBeLessThan(1_100);
    expect(after.endsWith('…')).toBe(true);

    const projects = await db.tables.createTable({ base_id: t.base.id, name: 'Projects', created_by: owner.id });
    const link = await db.tables.createField({
      table_id: projects.table.id,
      name: 'Items',
      type: 'relation',
      config: { relation: { targetTableId: t.tableId, multiple: true } },
      created_by: owner.id,
    });
    await db.tables.createField({
      table_id: projects.table.id,
      name: 'Total',
      type: 'rollup',
      config: { rollup: { relationFieldId: link.id, targetFieldId: t.effort.id, aggregation: 'sum' } },
      created_by: owner.id,
    });
    const project = await db.tables.createRecord(
      { table_id: projects.table.id, values: { [projects.fields[0]!.id]: 'P', [link.id]: [record.id] } },
      full(owner.id),
      meta(owner.id),
    );
    await db.tables.updateRecord(
      { table_id: t.tableId, record_id: record.id, revision: 1, values: { [t.effort.id]: 4 } },
      full(owner.id),
      meta(owner.id),
    );
    expect((await db.tables.listRecordEvents(project.id)).map((event) => event.type)).toEqual(['created']);
  });

  it('rolls the history row back with a write that fails in the same transaction', async () => {
    const t = await formulaTable();
    const form = await db.tables.createForm({
      table_id: t.tableId,
      name: 'Once',
      status: 'published',
      config: { fieldIds: [t.primary.id] },
      user_id: owner.id,
    });
    // `allowMultiple` normalization arrives with slice Fm; set it directly.
    await db.executeRaw(
      sql`UPDATE table_forms SET config = config || '{"allowMultiple": false}'::jsonb WHERE id = ${form.id}`,
    );
    const formMeta = meta(mate.id, { actorKind: 'form' });
    const first = await db.tables.submitForm(form.id, { [t.primary.id]: 'First' }, full(mate.id), formMeta);
    await expect(
      db.tables.submitForm(form.id, { [t.primary.id]: 'Second' }, full(mate.id), formMeta),
    ).rejects.toThrow();

    const records = await db.tables.queryRecords(t.tableId, {}, full(owner.id));
    expect(records.records.map((record) => record.id)).toEqual([first.id]);
    const events = (await db.executeRaw(
      sql`SELECT record_id, actor_kind, meta FROM table_record_events WHERE table_id = ${t.tableId}`,
    )) as Array<{ record_id: number; actor_kind: string; meta: Record<string, unknown> }>;
    expect(events).toEqual([{ record_id: first.id, actor_kind: 'form', meta: { formId: form.id } }]);
    const submissions = (await db.executeRaw(
      sql`SELECT record_id, single_submit FROM table_form_submissions WHERE form_id = ${form.id}`,
    )) as Array<{ record_id: number; single_submit: boolean }>;
    expect(submissions).toEqual([{ record_id: first.id, single_submit: true }]);
  });

  it('keeps the legacy executor running on the new action shape, recording automation writes as such', async () => {
    const t = await formulaTable();
    const flag = await db.tables.createField({
      table_id: t.tableId,
      name: 'Flag',
      type: 'text',
      created_by: owner.id,
    });
    const rule = await db.tables.createAutomationRule({
      base_id: t.base.id,
      table_id: t.tableId,
      name: 'Flag new items',
      status: 'enabled',
      trigger: 'record_created',
      config: {
        condition: { combinator: 'and', clauses: [{ systemField: 'created_by', operator: 'eq', value: '$me' }] },
        actions: [
          { type: 'update_record', values: [{ fieldId: flag.id, value: 'seen' }] },
          { type: 'notify', recipients: { creator: true, userIds: [mate.id] }, title: 'New', message: 'Created' },
        ],
      },
      execution_user_id: owner.id,
      user_id: owner.id,
    });
    expect(rule.config.actions.map((action) => action.id)).toEqual(['a1', 'a2']);

    const record = await db.tables.createRecord(
      { table_id: t.tableId, values: { [t.primary.id]: 'Auto' } },
      full(owner.id),
      meta(owner.id),
    );
    const [run] = await db.tables.listAutomationRuns(rule.id);
    expect(run).toMatchObject({ status: 'succeeded', actions_completed: 2, trigger_kind: 'record_created' });
    expect(run!.steps.map((step) => [step.actionId, step.status])).toEqual([
      ['a1', 'succeeded'],
      ['a2', 'succeeded'],
    ]);
    const events = (await db.tables.listRecordEvents(record.id)).reverse();
    expect(events.map((event) => [event.type, event.actor_kind])).toEqual([
      ['created', 'user'],
      ['updated', 'automation'],
    ]);
    expect(events[1]!.meta).toEqual({ ruleId: rule.id, executorId: owner.id });
    expect((await db.tables.listNotifications(owner.id)).map((row) => row.record_id)).toContain(record.id);
    expect((await db.tables.listNotifications(mate.id)).map((row) => row.record_id)).toContain(record.id);

    // Imports and automations' own writes do not trigger rules.
    const quiet = await db.tables.createRecord(
      { table_id: t.tableId, values: { [t.primary.id]: 'Quiet' } },
      full(owner.id),
      meta(owner.id, { actorKind: 'import', enqueueAutomations: false }),
    );
    expect((await db.tables.listAutomationRuns(rule.id)).length).toBe(1);
    expect((await db.tables.getRecord(t.tableId, quiet.id, full(owner.id)))?.values[String(flag.id)]).toBeUndefined();
  });

  it('normalizes legacy automation configs to stable action ids and refuses actions not built yet', async () => {
    const t = await formulaTable();
    const legacy = await db.tables.createAutomationRule({
      base_id: t.base.id,
      table_id: t.tableId,
      name: 'Legacy',
      trigger: 'record_updated',
      config: {
        actions: [
          { type: 'update_record', values: { [t.effort.id]: 1 } },
          { type: 'notify', userIds: [mate.id], title: 'Hi', message: 'There' },
        ],
      } as never,
      execution_user_id: owner.id,
      user_id: owner.id,
    });
    expect(legacy.config.actions).toEqual([
      { id: 'a1', type: 'update_record', values: [{ fieldId: t.effort.id, value: 1 }] },
      { id: 'a2', type: 'notify', recipients: { userIds: [mate.id] }, title: 'Hi', message: 'There' },
    ]);
    const updated = await db.tables.updateAutomationRule(legacy.id, {
      revision: legacy.revision,
      config: {
        actions: [
          { id: 'a2', type: 'notify', recipients: { userIds: [mate.id] }, title: 'Hi', message: 'There' },
          { type: 'update_record', values: [{ fieldId: t.effort.id, value: 2 }] },
        ],
      },
      user_id: owner.id,
    });
    expect(updated.ok && updated.value.config.actions.map((action) => action.id)).toEqual(['a2', 'a3']);
    await expect(
      db.tables.createAutomationRule({
        base_id: t.base.id,
        table_id: t.tableId,
        name: 'Hook',
        trigger: 'record_created',
        config: { actions: [{ type: 'webhook', url: 'https://example.com/hook' }] },
        execution_user_id: owner.id,
        user_id: owner.id,
      }),
    ).rejects.toMatchObject({ code: 'not_supported' });
    await expect(
      db.tables.createAutomationRule({
        base_id: t.base.id,
        table_id: t.tableId,
        name: 'Computed',
        trigger: 'record_created',
        config: { actions: [{ type: 'update_record', values: [{ fieldId: t.doubled.id, value: 1 }] }] },
        execution_user_id: owner.id,
        user_id: owner.id,
      }),
    ).rejects.toThrow(/computed/);
  });
});
