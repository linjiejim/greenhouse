/**
 * Slice D against real PostgreSQL: the card evaluator (date buckets in the
 * viewer's zone, series, pivots, KPI, filter controls incl. presets and `$me`,
 * drill-down, controls on unreadable targets ignored for a scoped reader) and
 * the dashboard routes (card widgets keep `type` / `table_id` consistent,
 * legacy flat widgets still evaluate, filter configs are schema-checked,
 * `queryDashboardWidget` takes filter values, a time zone and a drill point).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  _resetProvider,
  initDatabase,
  type CreateTableFieldInput,
  type DatabaseProvider,
  type TableFieldRow,
  type UserRow,
} from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { fullTableAccess, type TableDataScope } from '@greenhouse/types/table-access';
import type { TableCardSpec, TableFilterControl, TableRecordWriteMeta } from '@greenhouse/types/tables';
import type { AppEnv } from '../../../app-env.js';
import tablesRoutes from '../../../routes/tables/index.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../runtime.js';
import { tablesRegistration } from '../application.js';
import { evaluateTableCard } from '../cards.js';
import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let mate: UserRow;

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  [owner, mate] = await Promise.all([
    createInternalTestUser(db, { email: `tables-d-owner-${tag}@test.local`, nickname: 'Dash Owner' }),
    createInternalTestUser(db, { email: `tables-d-mate-${tag}@test.local`, nickname: 'Dash Mate' }),
  ]);
});

afterEach(async () => {
  resetPlatformRuntimeForTests();
  _resetProvider();
});

const meta = (actorId: string): TableRecordWriteMeta => ({ actorId, actorKind: 'user', enqueueAutomations: false });

/**
 * Four deals. "Delta" signs at 2026-03-31 17:00 UTC — still March in UTC but
 * already 1 April in Shanghai (UTC+8), so month buckets differ by zone.
 */
async function deals() {
  const base = await db.tables.createBase({ name: `Sales ${Math.random()}`, owner_id: owner.id, created_by: owner.id });
  const schema = await db.tables.createTable({ base_id: base.id, name: 'Deals', created_by: owner.id });
  const tableId = schema.table.id;
  const field = (
    name: string,
    type: TableFieldRow['type'],
    extra: Partial<Pick<CreateTableFieldInput, 'config'>> = {},
  ) => db.tables.createField({ table_id: tableId, name, type, created_by: owner.id, ...extra });
  const name = schema.fields[0]!;
  const stage = await field('Stage', 'single_select', {
    config: {
      options: [
        { id: 'open', label: 'Open' },
        { id: 'won', label: 'Won' },
      ],
    },
  });
  const amount = await field('Amount', 'number');
  const rep = await field('Rep', 'user');
  const signed = await field('Signed', 'datetime');
  const note = await field('Note', 'text');
  const create = (values: Record<number, unknown>) =>
    db.tables.createRecord({ table_id: tableId, values }, fullTableAccess(owner.id), meta(owner.id));
  const alpha = await create({
    [name.id]: 'Alpha',
    [stage.id]: 'open',
    [amount.id]: 100,
    [rep.id]: owner.id,
    [signed.id]: '2026-03-10T09:00:00.000Z',
    [note.id]: 'renewal',
  });
  const bravo = await create({
    [name.id]: 'Bravo',
    [stage.id]: 'won',
    [amount.id]: 200,
    [rep.id]: mate.id,
    [signed.id]: '2026-03-15T09:00:00.000Z',
  });
  const delta = await create({
    [name.id]: 'Delta',
    [stage.id]: 'won',
    [amount.id]: 300,
    [rep.id]: owner.id,
    [signed.id]: '2026-03-31T17:00:00.000Z',
    [note.id]: 'renewal',
  });
  const echo = await create({
    [name.id]: 'Echo',
    [stage.id]: 'won',
    [amount.id]: 50,
    [rep.id]: owner.id,
    [signed.id]: '2026-04-20T09:00:00.000Z',
  });
  return { base, tableId, name, stage, amount, rep, signed, note, alpha, bravo, delta, echo };
}

type Deals = Awaited<ReturnType<typeof deals>>;

function monthlyByStage(w: Deals): TableCardSpec {
  return {
    kind: 'chart',
    source: { tableId: w.tableId },
    aggregate: {
      operation: 'count',
      groupBy: { fieldId: w.signed.id, dateBucket: 'month' },
      series: { fieldId: w.stage.id },
    },
    chart: { type: 'bar', stacked: true },
  };
}

const NOW = new Date('2026-04-25T12:00:00.000Z');

describe('evaluateTableCard', () => {
  it('buckets by month in the viewer zone and splits by series', async () => {
    const w = await deals();
    const card = monthlyByStage(w);
    const utc = await evaluateTableCard(db, card, { timezone: 'UTC' }, fullTableAccess(owner.id));
    expect(utc).toEqual({
      kind: 'chart',
      rows: [
        { group: '2026-03-01', series: 'open', value: 1 },
        { group: '2026-03-01', series: 'won', value: 2 },
        { group: '2026-04-01', series: 'won', value: 1 },
      ],
    });
    const shanghai = await evaluateTableCard(db, card, { timezone: 'Asia/Shanghai' }, fullTableAccess(owner.id));
    expect(shanghai).toEqual({
      kind: 'chart',
      rows: [
        { group: '2026-03-01', series: 'open', value: 1 },
        { group: '2026-03-01', series: 'won', value: 1 },
        { group: '2026-04-01', series: 'won', value: 2 },
      ],
    });
  });

  it('keeps the latest time buckets when they outnumber the limit, still read oldest → newest', async () => {
    const w = await deals();
    await db.tables.createRecord(
      { table_id: w.tableId, values: { [w.name.id]: 'Undated', [w.stage.id]: 'open' } },
      fullTableAccess(owner.id),
      meta(owner.id),
    );
    const monthly = (limit: number, extra: Partial<NonNullable<TableCardSpec['aggregate']>> = {}): TableCardSpec => ({
      kind: 'chart',
      source: { tableId: w.tableId },
      aggregate: { operation: 'count', groupBy: { fieldId: w.signed.id, dateBucket: 'month' }, limit, ...extra },
    });
    const evaluate = (card: TableCardSpec) =>
      evaluateTableCard(db, card, { timezone: 'UTC' }, fullTableAccess(owner.id));

    expect(await evaluate(monthly(1))).toEqual({ kind: 'chart', rows: [{ group: '2026-04-01', value: 1 }] });
    // Room for every bucket: chronological, the no-date bucket last.
    expect(await evaluate(monthly(5))).toEqual({
      kind: 'chart',
      rows: [
        { group: '2026-03-01', value: 3 },
        { group: '2026-04-01', value: 1 },
        { group: null, value: 1 },
      ],
    });
    // Stacked: the latest bucket's series, in series order.
    expect(await evaluate(monthly(1, { series: { fieldId: w.stage.id } }))).toEqual({
      kind: 'chart',
      rows: [{ group: '2026-04-01', series: 'won', value: 1 }],
    });
    expect(await evaluate(monthly(2, { series: { fieldId: w.stage.id } }))).toEqual({
      kind: 'chart',
      rows: [
        { group: '2026-03-01', series: 'open', value: 1 },
        { group: '2026-03-01', series: 'won', value: 2 },
        { group: '2026-04-01', series: 'won', value: 1 },
      ],
    });
    // An explicit sort is the author's choice and is kept as asked.
    expect(await evaluate(monthly(1, { sort: 'group_asc' }))).toEqual({
      kind: 'chart',
      rows: [{ group: '2026-03-01', value: 3 }],
    });
  });

  it('pivots a sum by stage × rep, and answers KPIs and text', async () => {
    const w = await deals();
    const pivot = await evaluateTableCard(
      db,
      {
        kind: 'pivot',
        source: { tableId: w.tableId },
        aggregate: {
          operation: 'sum',
          valueFieldId: w.amount.id,
          groupBy: { fieldId: w.stage.id },
          series: { fieldId: w.rep.id },
        },
      },
      {},
      fullTableAccess(owner.id),
    );
    expect(pivot.kind).toBe('pivot');
    const cells = pivot.kind === 'pivot' ? pivot.rows : [];
    const cell = (group: string, series: string) =>
      cells.find((row) => row.group === group && row.series === series)?.value;
    expect(cell('won', owner.id)).toBe(350);
    expect(cell('won', mate.id)).toBe(200);
    expect(cell('open', owner.id)).toBe(100);

    const kpi = await evaluateTableCard(
      db,
      { kind: 'kpi', source: { tableId: w.tableId }, aggregate: { operation: 'avg', valueFieldId: w.amount.id } },
      {},
      fullTableAccess(owner.id),
    );
    expect(kpi).toEqual({ kind: 'kpi', value: 162.5 });
    expect(await evaluateTableCard(db, { kind: 'text', markdown: '# Hi' }, {}, fullTableAccess(null))).toEqual({
      kind: 'text',
      markdown: '# Hi',
    });
  });

  it('applies date-range presets in the viewer zone, $me, select and search controls together', async () => {
    const w = await deals();
    const controls: TableFilterControl[] = [
      { id: 'period', label: 'Period', kind: 'date_range', targets: [{ tableId: w.tableId, fieldId: w.signed.id }] },
      { id: 'rep', label: 'Rep', kind: 'user', targets: [{ tableId: w.tableId, fieldId: w.rep.id }] },
      {
        id: 'stage',
        label: 'Stage',
        kind: 'select',
        targets: [{ tableId: w.tableId, fieldId: w.stage.id }],
        defaultValue: { kind: 'select', values: ['won', 'retired-option'] },
      },
      { id: 'q', label: 'Search', kind: 'search', targets: [{ tableId: w.tableId, fieldId: w.note.id }] },
      // Targets another table: never applies to this card.
      { id: 'elsewhere', label: 'Else', kind: 'search', targets: [{ tableId: w.tableId + 999, fieldId: 1 }] },
    ];
    const count = async (filterValues: Record<string, unknown>, timezone = 'Asia/Shanghai', userId = owner.id) => {
      const result = await evaluateTableCard(
        db,
        { kind: 'kpi', source: { tableId: w.tableId }, aggregate: { operation: 'count' } },
        { controls, filterValues, timezone, now: NOW },
        fullTableAccess(userId),
      );
      return result.kind === 'kpi' ? result.value : -1;
    };
    // Defaults only: stage = won (the retired option is dropped, not an error).
    expect(await count({})).toBe(3);
    // This month in Shanghai = April: Delta (1 Apr local) + Echo.
    expect(await count({ period: { kind: 'date_range', preset: 'this_month' } })).toBe(2);
    expect(await count({ period: { kind: 'date_range', preset: 'this_month' } }, 'UTC')).toBe(1);
    // $me is the reader.
    expect(await count({ rep: { kind: 'user', userIds: ['$me'] } })).toBe(2);
    expect(await count({ rep: { kind: 'user', userIds: ['$me'] } }, 'UTC', mate.id)).toBe(1);
    // Cleared default + search.
    expect(await count({ stage: null, q: { kind: 'search', text: 'RENEW' } })).toBe(2);
    expect(
      await count({
        stage: null,
        q: { kind: 'search', text: 'renew' },
        period: { kind: 'date_range', from: '2026-03-01', to: '2026-03-31' },
      }),
    ).toBe(1);
  });

  it('drills into the records behind a stacked bar in the same zone', async () => {
    const w = await deals();
    const card = monthlyByStage(w);
    const drill = async (group: string, series: string, timezone: string) => {
      const result = await evaluateTableCard(
        db,
        card,
        { timezone, drilldown: { group, series } },
        fullTableAccess(owner.id),
      );
      return result.kind === 'records' ? result.page.records.map((record) => record.id).sort((a, b) => a - b) : [];
    };
    expect(await drill('2026-04-01', 'won', 'Asia/Shanghai')).toEqual([w.delta.id, w.echo.id].sort((a, b) => a - b));
    expect(await drill('2026-04-01', 'won', 'UTC')).toEqual([w.echo.id]);
    expect(await drill('2026-03-01', 'open', 'UTC')).toEqual([w.alpha.id]);
  });

  it('ignores controls on fields a scoped reader cannot read, but applies the rest and the row scope', async () => {
    const w = await deals();
    const scope: TableDataScope = {
      kind: 'scoped',
      userId: mate.id,
      tableId: w.tableId,
      rows: [
        {
          type: 'where',
          where: { combinator: 'and', clauses: [{ fieldId: w.amount.id, operator: 'gte', value: 100 }] },
        },
      ],
      editRows: [],
      // Stage and Amount hidden; Rep and Signed readable.
      readableFieldIds: [w.name.id, w.rep.id, w.signed.id],
      editableFieldIds: [],
      canCreate: false,
      canDelete: false,
    };
    const controls: TableFilterControl[] = [
      { id: 'stage', label: 'Stage', kind: 'select', targets: [{ tableId: w.tableId, fieldId: w.stage.id }] },
      { id: 'rep', label: 'Rep', kind: 'user', targets: [{ tableId: w.tableId, fieldId: w.rep.id }] },
    ];
    const kpi: TableCardSpec = { kind: 'kpi', source: { tableId: w.tableId }, aggregate: { operation: 'count' } };
    const count = async (filterValues: Record<string, unknown>) => {
      const result = await evaluateTableCard(db, kpi, { controls, filterValues }, scope);
      return result.kind === 'kpi' ? result.value : -1;
    };
    // Row scope (amount ≥ 100) leaves Alpha, Bravo, Delta; Echo (50) is out.
    expect(await count({})).toBe(3);
    // A value for the hidden Stage control is ignored — no oracle over hidden data.
    expect(await count({ stage: { kind: 'select', values: ['open'] } })).toBe(3);
    // The readable Rep control still applies.
    expect(await count({ rep: { kind: 'user', userIds: [owner.id] } })).toBe(2);

    // The card itself cannot group by a hidden field.
    await expect(
      evaluateTableCard(
        db,
        {
          kind: 'chart',
          source: { tableId: w.tableId },
          aggregate: { operation: 'count', groupBy: { fieldId: w.stage.id } },
        },
        {},
        scope,
      ),
    ).rejects.toThrow(/unavailable/);
    // Records come back projected to readable fields.
    const records = await evaluateTableCard(db, { kind: 'records', source: { tableId: w.tableId } }, {}, scope);
    const first = records.kind === 'records' ? records.page.records[0] : undefined;
    expect(
      Object.keys(first?.values ?? {})
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([w.name.id, w.rep.id, w.signed.id].sort((a, b) => a - b));
  });
});

// ─── HTTP ─────────────────────────────────────────────────

function createApp(users: UserRow[]) {
  const byId = new Map(users.map((user) => [user.id, user]));
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const user = byId.get(c.req.header('x-test-user') ?? '');
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  app.route('/api/tables', tablesRoutes);
  return app;
}

describe('dashboard routes', () => {
  it('stores card widgets consistently, evaluates them with filters and drill-down, and checks filter configs', async () => {
    initializePlatformRuntime(db, [tablesRegistration]);
    const app = createApp([owner, mate]);
    const w = await deals();
    const call = async (method: string, path: string, body?: unknown, user = owner) => {
      const response = await app.request(`/api/tables${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-test-user': user.id },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };

    const dashboard = (await call('POST', `/bases/${w.base.id}/dashboards`, { name: 'Pipeline' })).body.dashboard;
    // A card widget: the stored type follows the card; table_id follows its source.
    const created = await call('POST', `/dashboards/${dashboard.id}/widgets`, {
      title: 'Monthly',
      config: { card: { ...monthlyByStage(w), chart: { type: 'area', stacked: true } } },
    });
    expect(created.status).toBe(201);
    expect(created.body.widget).toMatchObject({ type: 'area', table_id: w.tableId });
    // A legacy flat widget still works and is stored as a card.
    const legacy = await call('POST', `/dashboards/${dashboard.id}/widgets`, {
      type: 'kpi',
      title: 'Total',
      tableId: w.tableId,
      config: { operation: 'sum', valueFieldId: w.amount.id },
    });
    expect(JSON.parse(legacy.body.widget.config)).toEqual({
      version: 2,
      card: { kind: 'kpi', source: { tableId: w.tableId }, aggregate: { operation: 'sum', valueFieldId: w.amount.id } },
    });
    // Switching the card to a pivot keeps the type column in step.
    const switched = await call('PATCH', `/dashboard-widgets/${created.body.widget.id}`, {
      revision: created.body.widget.revision,
      config: {
        card: {
          kind: 'pivot',
          source: { tableId: w.tableId },
          aggregate: { operation: 'count', groupBy: { fieldId: w.stage.id } },
        },
      },
    });
    expect(switched.body.widget.type).toBe('pivot');
    // Bad cards are refused at save time.
    const badCard = await call('POST', `/dashboards/${dashboard.id}/widgets`, {
      title: 'Bad',
      config: {
        card: {
          kind: 'chart',
          source: { tableId: w.tableId },
          aggregate: { operation: 'sum', valueFieldId: w.name.id },
        },
      },
    });
    expect(badCard.status).toBe(400);

    // Filter configs: type-checked against the schema.
    const wrongType = await call('PATCH', `/dashboards/${dashboard.id}`, {
      revision: dashboard.revision,
      config: {
        filters: [{ id: 'p', label: 'P', kind: 'date_range', targets: [{ tableId: w.tableId, fieldId: w.name.id }] }],
      },
    });
    expect(wrongType.status).toBe(400);
    const configured = await call('PATCH', `/dashboards/${dashboard.id}`, {
      revision: dashboard.revision,
      config: {
        filters: [
          {
            id: 'period',
            label: 'Period',
            kind: 'date_range',
            targets: [{ tableId: w.tableId, fieldId: w.signed.id }],
          },
          { id: 'rep', label: 'Rep', kind: 'user', targets: [{ tableId: w.tableId, fieldId: w.rep.id }] },
        ],
      },
    });
    expect(configured.status).toBe(200);
    expect(configured.body.dashboard.config.filters).toHaveLength(2);

    const query = (widgetId: number, body: unknown) => call('POST', `/dashboard-widgets/${widgetId}/query`, body);
    const total = await query(legacy.body.widget.id, {
      timezone: 'Asia/Shanghai',
      filterValues: {
        period: { kind: 'date_range', from: '2026-04-01', to: '2026-04-30' },
        rep: { kind: 'user', userIds: ['$me'] },
      },
    });
    expect(total.body.result).toEqual({ kind: 'kpi', value: 350 });
    expect(total.body.card.kind).toBe('kpi');

    const pivot = await query(created.body.widget.id, {});
    expect(pivot.body.result.kind).toBe('pivot');
    const drilled = await query(created.body.widget.id, { drilldown: { group: 'won' } });
    expect(drilled.body.result.kind).toBe('records');
    expect(drilled.body.result.page.records).toHaveLength(3);
    expect((await query(created.body.widget.id, { drilldown: { group: { nested: true } } })).status).toBe(400);

    // Non-members see nothing.
    expect((await call('GET', `/dashboards/${dashboard.id}`, undefined, mate)).status).toBe(404);
    expect((await call('POST', `/dashboard-widgets/${created.body.widget.id}/query`, {}, mate)).status).toBe(404);
  });
});
