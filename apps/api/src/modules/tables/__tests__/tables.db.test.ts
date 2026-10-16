import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { RealtimeEvent } from '@greenhouse/contract';
import { auditEvents, baseTables, getDb, groupMembers, groups, members, newId, notifications } from '@greenhouse/db';
import { createTestApp } from '../../../testing.js';

type App = ReturnType<typeof createTestApp>;
type Who = Awaited<ReturnType<App['member']>>;

async function setup() {
  const app = createTestApp({ STORAGE_PROVIDER: 'local', STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'gh-tables-')) });
  const person = async (name: string, role: 'admin' | 'member' = 'member') => {
    const who = await app.member(role);
    await getDb().update(members).set({ name, timezone: 'Asia/Shanghai' }).where(eq(members.id, who.id));
    return { ...who, name };
  };
  const lin = await person('Lin');
  const mei = await person('Mei');
  const as = (who: Who) => ({
    get: (path: string) => app.call('GET', path, { token: who.token }),
    post: (path: string, body: unknown = {}) => app.call('POST', path, { token: who.token, body }),
    patch: (path: string, body: unknown) => app.call('PATCH', path, { token: who.token, body }),
    put: (path: string, body: unknown) => app.call('PUT', path, { token: who.token, body }),
    del: (path: string) => app.call('DELETE', path, { token: who.token }),
  });
  /** Realtime events a member's open sockets would get. */
  function listen(who: Who) {
    const events: RealtimeEvent[] = [];
    app.services.hub.subscribe(who.id, (event) => events.push(event));
    return events;
  }
  return { app, lin, mei, person, as, listen };
}

/** A blank base with a few fields of different kinds on its first table. */
async function blank(as: ReturnType<Awaited<ReturnType<typeof setup>>['as']>, name = 'Inventory') {
  const base = (await as.post('/api/tables/bases', { name })).body;
  const table = base.tables[0];
  const field = async (body: object) => {
    const made = await as.post(`/api/tables/tables/${table.id}/fields`, body);
    expect(made.status).toBe(201);
    return made.body;
  };
  const status = await field({
    name: 'Status',
    type: 'single_select',
    config: {
      options: [
        { id: 'todo', label: 'To do', color: 'gray' },
        { id: 'doing', label: 'Doing', color: 'blue' },
        { id: 'done', label: 'Done', color: 'green' },
      ],
    },
  });
  const count = await field({ name: 'Count', type: 'number' });
  const due = await field({ name: 'Due', type: 'date' });
  const owner = await field({ name: 'Owner', type: 'member' });
  const primary = table.fields[0];
  return { base, table, primary, status, count, due, owner };
}

/** The data table's schema revision now: field changes name it. */
async function schemaOf(_as: unknown, tableId: string) {
  const [row] = await getDb().select().from(baseTables).where(eq(baseTables.id, tableId));
  return row!.schemaRevision;
}

describe('bases', () => {
  it('makes a blank base with one data table, its primary field and a grid, owned by its maker', async () => {
    const { lin, mei, as } = await setup();
    const made = await as(lin).post('/api/tables/bases', { name: 'Inventory' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      name: 'Inventory',
      access: 'owner',
      owner: { id: lin.id, name: 'Lin' },
      pinned: false,
      template_key: null,
    });
    expect(made.body.tables).toHaveLength(1);
    expect(made.body.tables[0]).toMatchObject({
      name: '数据表 1',
      fields: [{ name: '名称', type: 'text', is_primary: true }],
    });
    expect(made.body.views).toEqual([
      expect.objectContaining({ name: '表格', type: 'grid', personal: false, editable: true }),
    ]);

    const listed = await as(lin).get('/api/tables/bases');
    expect(listed.body.items).toEqual([
      expect.objectContaining({
        id: made.body.id,
        access: 'owner',
        tables: [expect.objectContaining({ name: '数据表 1', views: [expect.objectContaining({ type: 'grid' })] })],
      }),
    ]);
    // Nobody else sees it until it is shared.
    expect((await as(mei).get('/api/tables/bases')).body.items).toEqual([]);
    expect((await as(mei).get(`/api/tables/bases/${made.body.id}`)).status).toBe(404);
  });

  it('makes a base from the 项目 template: projects, tasks with milestones, links and four task views', async () => {
    const { lin, as } = await setup();
    const made = await as(lin).post('/api/tables/bases', { template: 'project' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: '项目管理', template_key: 'project' });
    const [projects, tasks] = made.body.tables;
    expect(projects.name).toBe('项目');
    expect(tasks.name).toBe('任务');
    expect(tasks.fields.map((field: any) => field.type)).toEqual([
      'text',
      'relation',
      'single_select',
      'single_select',
      'member',
      'date',
      'date',
      'parent',
      'dependency',
      'single_select',
      'long_text',
    ]);
    const relation = tasks.fields.find((field: any) => field.type === 'relation');
    expect(relation.config).toEqual({ table_id: projects.id, multiple: false });
    const taskViews = made.body.views.filter((view: any) => view.table_id === tasks.id);
    expect(taskViews.map((view: any) => view.type)).toEqual(['grid', 'kanban', 'timeline', 'calendar']);
    const timeline = taskViews.find((view: any) => view.type === 'timeline');
    const field = (name: string) => tasks.fields.find((entry: any) => entry.name === name).id;
    expect(timeline.config.timeline).toEqual({
      start: field('开始日期'),
      end: field('截止日期'),
      dependency: field('依赖'),
      milestone: { field: field('类型'), option: 'milestone' },
      scale: 'week',
    });

    const rows = await as(lin).post(`/api/tables/tables/${tasks.id}/records/query`, { limit: 50, count: true });
    expect(rows.body.total).toBe(9);
    const byTitle = new Map(rows.body.items.map((row: any) => [row.values[tasks.fields[0].id], row]));
    const review: any = byTitle.get('联调与验收');
    expect(review.values[field('依赖')]).toHaveLength(2);
    expect(review.values[field('项目')]).toHaveLength(1);
    expect(rows.body.linked[review.values[field('项目')][0]]).toMatchObject({
      title: '示例项目',
      table_id: projects.id,
    });
    const homeDesign: any = byTitle.get('首页设计');
    expect(rows.body.linked[homeDesign.values[field('父任务')][0]].title).toBe('设计');
    const research: any = byTitle.get('需求调研');
    expect(research.values[field('负责人')]).toEqual([lin.id]);
    expect(research.values[field('开始日期')]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The parent knows its children.
    const design: any = byTitle.get('设计');
    const detail = await as(lin).get(`/api/tables/records/${design.id}`);
    expect(detail.body.children.map((child: any) => child.title).sort()).toEqual(['详情页设计', '首页设计'].sort());
  });

  it('renames, pins for me, archives and restores, and deletes only with the name typed again', async () => {
    const { lin, as } = await setup();
    const base = (await as(lin).post('/api/tables/bases', { name: 'Old' })).body;
    expect((await as(lin).patch(`/api/tables/bases/${base.id}`, { name: 'New', pinned: true })).body).toMatchObject({
      name: 'New',
      pinned: true,
    });
    expect((await as(lin).post(`/api/tables/bases/${base.id}/archive`)).body.archived_at).not.toBeNull();
    expect((await as(lin).get('/api/tables/bases')).body.items).toEqual([]);
    expect((await as(lin).get('/api/tables/bases?archived=true')).body.items).toHaveLength(1);
    expect((await as(lin).post(`/api/tables/bases/${base.id}/restore`)).body.archived_at).toBeNull();

    const wrong = await as(lin).post(`/api/tables/bases/${base.id}/delete`, { name: 'Old' });
    expect(wrong.status).toBe(400);
    expect((await as(lin).post(`/api/tables/bases/${base.id}/delete`, { name: 'New' })).status).toBe(204);
    expect((await as(lin).get(`/api/tables/bases/${base.id}`)).status).toBe(404);
    const audited = await getDb().select().from(auditEvents).where(eq(auditEvents.resourceId, base.id));
    expect(audited.map((row) => row.action).sort()).toEqual(['base.archive', 'base.delete', 'base.restore']);
  });

  it('is closed to a member whose tables module is off', async () => {
    const { lin, as } = await setup();
    await getDb()
      .update(members)
      .set({ modules: { tables: false } })
      .where(eq(members.id, lin.id));
    expect((await as(lin).get('/api/tables/bases')).status).toBe(403);
  });
});

describe('fields and views', () => {
  it('adds, renames and deletes fields; names are unique; one parent and one dependency field per table', async () => {
    const { lin, as } = await setup();
    const { table, status } = await blank(as(lin));
    const clash = await as(lin).post(`/api/tables/tables/${table.id}/fields`, { name: 'Status', type: 'text' });
    expect(clash).toMatchObject({ status: 409, body: { error: { code: 'name_taken' } } });
    expect(
      (await as(lin).post(`/api/tables/tables/${table.id}/fields`, { name: 'Parent', type: 'parent' })).status,
    ).toBe(201);
    const second = await as(lin).post(`/api/tables/tables/${table.id}/fields`, { name: 'Parent 2', type: 'parent' });
    expect(second.body.error.code).toBe('one_per_table');

    const revision = await schemaOf(as(lin), table.id);
    const renamed = await as(lin).patch(`/api/tables/fields/${status.id}`, {
      schema_revision: revision,
      name: 'State',
    });
    expect(renamed.body).toMatchObject({ name: 'State', type: 'single_select' });
    // A change based on the schema before the rename is refused.
    const late = await as(lin).patch(`/api/tables/fields/${status.id}`, { schema_revision: revision, name: 'Later' });
    expect(late).toMatchObject({ status: 409, body: { error: { code: 'stale_schema' } } });
    const primary = table.fields[0];
    expect((await as(lin).del(`/api/tables/fields/${primary.id}`)).body.error.code).toBe('primary_field');
    const now = await schemaOf(as(lin), table.id);
    expect(
      (await as(lin).patch(`/api/tables/fields/${status.id}`, { schema_revision: now, type: 'number' })).body.error
        .code,
    ).toBe('type_change_unsupported');
  });

  it('drops a deleted field from every view, and brings the field back from the recycle bin', async () => {
    const { lin, as } = await setup();
    const { base, table, status, count } = await blank(as(lin));
    const grid = base.views[0];
    const saved = await as(lin).patch(`/api/tables/views/${grid.id}`, {
      revision: grid.revision,
      config: {
        filter: { mode: 'and', clauses: [{ field: status.id, op: 'eq', value: 'todo' }] },
        sorts: [{ field: count.id, desc: true }],
        group: { field: status.id },
        hidden: [count.id],
      },
    });
    expect(saved.status).toBe(200);
    expect((await as(lin).del(`/api/tables/fields/${status.id}`)).status).toBe(204);
    const after = (await as(lin).get(`/api/tables/bases/${base.id}`)).body;
    expect(after.views[0].config).toEqual({ sorts: [{ field: count.id, desc: true }], hidden: [count.id] });
    expect(after.tables[0].fields.map((field: any) => field.name)).not.toContain('Status');
    const trash = await as(lin).get(`/api/tables/bases/${base.id}/trash`);
    expect(trash.body.items).toEqual([expect.objectContaining({ kind: 'field', id: status.id, table_id: table.id })]);
    expect((await as(lin).post(`/api/tables/fields/${status.id}/restore`)).body.name).toBe('Status');
  });

  it('keeps shared views to builders and personal views to their owner, with revisions', async () => {
    const { lin, mei, as } = await setup();
    const { base, table } = await blank(as(lin));
    await as(lin).put(`/api/tables/bases/${base.id}/share`, {
      items: [{ type: 'member', id: mei.id, role: 'viewer' }],
    });
    const shared = await as(mei).post(`/api/tables/tables/${table.id}/views`, { name: 'Mine', type: 'grid' });
    expect(shared.status).toBe(403);
    const personal = await as(mei).post(`/api/tables/tables/${table.id}/views`, {
      name: 'Mine',
      type: 'grid',
      personal: true,
    });
    expect(personal.body).toMatchObject({ personal: true, editable: true });
    // Lin does not see Mei's personal view; Mei cannot change the shared grid.
    const linBase = (await as(lin).get(`/api/tables/bases/${base.id}`)).body;
    expect(linBase.views.map((view: any) => view.name)).toEqual(['表格']);
    const meiBase = (await as(mei).get(`/api/tables/bases/${base.id}`)).body;
    expect(meiBase.views.map((view: any) => [view.name, view.editable])).toEqual([
      ['表格', false],
      ['Mine', true],
    ]);
    const grid = linBase.views[0];
    expect((await as(mei).patch(`/api/tables/views/${grid.id}`, { revision: grid.revision, name: 'X' })).status).toBe(
      403,
    );
    const first = await as(lin).patch(`/api/tables/views/${grid.id}`, { revision: grid.revision, name: 'All' });
    expect(first.body.revision).toBe(grid.revision + 1);
    const late = await as(lin).patch(`/api/tables/views/${grid.id}`, { revision: grid.revision, name: 'Late' });
    expect(late).toMatchObject({ status: 409, body: { error: { code: 'stale_revision' } } });
    expect((await as(lin).del(`/api/tables/views/${grid.id}`)).body.error.code).toBe('last_view');
    // A kanban needs a single select, a timeline a date: both have one here.
    const kanban = await as(lin).post(`/api/tables/tables/${table.id}/views`, { name: 'Board', type: 'kanban' });
    expect(kanban.body.config.kanban.field).toBeDefined();
    const newTable = (await as(lin).post(`/api/tables/bases/${base.id}/tables`, { name: 'Empty' })).body;
    const timeline = await as(lin).post(`/api/tables/tables/${newTable.id}/views`, { name: 'T', type: 'timeline' });
    expect(timeline).toMatchObject({ status: 409, body: { error: { code: 'view_needs_field' } } });
  });
});

describe('records', () => {
  it('creates and changes records with a revision; a stale change gets the record as it is now', async () => {
    const { lin, as, listen } = await setup();
    const { table, primary, status, count, due, owner } = await blank(as(lin));
    const events = listen(lin);
    const made = await as(lin).post(`/api/tables/tables/${table.id}/records`, {
      values: {
        [primary.id]: 'Pens',
        [status.id]: 'todo',
        [count.id]: 12,
        [due.id]: '2026-10-20',
        [owner.id]: [lin.id],
      },
    });
    expect(made.status).toBe(201);
    const record = made.body.record;
    expect(record).toMatchObject({ revision: 1, created_by: lin.id });
    expect(record.values).toEqual({
      [primary.id]: 'Pens',
      [status.id]: 'todo',
      [count.id]: 12,
      [due.id]: '2026-10-20',
      [owner.id]: [lin.id],
    });
    expect(events).toContainEqual({
      type: 'records.changed',
      data: {
        base_id: table.base_id,
        table_id: table.id,
        records: [{ id: record.id, revision: 1, computed_revision: 0 }],
      },
    });

    const changed = await as(lin).patch(`/api/tables/records/${record.id}`, {
      revision: 1,
      values: { [count.id]: 13, [status.id]: null },
    });
    expect(changed.body.record).toMatchObject({ revision: 2 });
    expect(changed.body.record.values[status.id]).toBeUndefined();
    const stale = await as(lin).patch(`/api/tables/records/${record.id}`, { revision: 1, values: { [count.id]: 1 } });
    expect(stale).toMatchObject({ status: 409, body: { error: { code: 'stale_revision' } } });
    expect(stale.body.error.details.record).toMatchObject({ id: record.id, revision: 2 });
    // The same values again change nothing.
    expect(
      (await as(lin).patch(`/api/tables/records/${record.id}`, { revision: 2, values: { [count.id]: 13 } })).body.record
        .revision,
    ).toBe(2);

    const bad = await as(lin).patch(`/api/tables/records/${record.id}`, {
      revision: 2,
      values: { [status.id]: 'nope' },
    });
    expect(bad).toMatchObject({
      status: 400,
      body: { error: { code: 'invalid_input', details: { field: status.id } } },
    });
    const text = await as(lin).patch(`/api/tables/records/${record.id}`, {
      revision: 2,
      values: { [count.id]: 'many' },
    });
    expect(text.status).toBe(400);

    const history = await as(lin).get(`/api/tables/records/${record.id}/activity`);
    expect(history.body.items.map((item: any) => item.type)).toEqual(['updated', 'created']);
    expect(history.body.items[0].changes).toEqual(
      expect.arrayContaining([
        { field: count.id, name: 'Count', before: 12, after: 13 },
        { field: status.id, name: 'Status', before: 'todo', after: null },
      ]),
    );
  });

  it('links records, refuses loops of parents and dependencies, and fills in linked titles', async () => {
    const { lin, as } = await setup();
    const base = (await as(lin).post('/api/tables/bases', { template: 'project' })).body;
    const tasks = base.tables[1];
    const field = (name: string) => tasks.fields.find((entry: any) => entry.name === name).id;
    const add = async (title: string, values: object = {}) =>
      (await as(lin).post(`/api/tables/tables/${tasks.id}/records`, { values: { [field('名称')]: title, ...values } }))
        .body.record;
    const a = await add('A');
    const b = await add('B', { [field('依赖')]: [a.id], [field('父任务')]: [a.id] });
    expect(b.values[field('依赖')]).toEqual([a.id]);
    const loop = await as(lin).patch(`/api/tables/records/${a.id}`, {
      revision: a.revision,
      values: { [field('依赖')]: [b.id] },
    });
    expect(loop).toMatchObject({ status: 409, body: { error: { code: 'link_cycle' } } });
    const parentLoop = await as(lin).patch(`/api/tables/records/${a.id}`, {
      revision: a.revision,
      values: { [field('父任务')]: [b.id] },
    });
    expect(parentLoop.body.error.code).toBe('link_cycle');
    const self = await as(lin).patch(`/api/tables/records/${a.id}`, {
      revision: a.revision,
      values: { [field('依赖')]: [a.id] },
    });
    expect(self.status).toBe(400);
    const two = await as(lin).patch(`/api/tables/records/${b.id}`, {
      revision: b.revision,
      values: { [field('父任务')]: [a.id, b.id] },
    });
    expect(two.status).toBe(400);
    // Deleting A hides its links; restoring brings them back.
    await as(lin).del(`/api/tables/records/${a.id}`);
    expect((await as(lin).get(`/api/tables/records/${b.id}`)).body.record.values[field('依赖')]).toBeUndefined();
    await as(lin).post(`/api/tables/records/${a.id}/restore`);
    const again = await as(lin).get(`/api/tables/records/${b.id}`);
    expect(again.body.record.values[field('依赖')]).toEqual([a.id]);
    expect(again.body.linked[a.id]).toMatchObject({ title: 'A' });
  });
});

describe('queries', () => {
  async function seeded() {
    const ctx = await setup();
    const fixture = await blank(ctx.as(ctx.lin));
    const { table, primary, status, count, due, owner } = fixture;
    const rows: Array<[string, string | null, number | null, string | null, string[]]> = [
      ['Apples', 'todo', 5, '2026-10-01', [ctx.lin.id]],
      ['Bananas', 'doing', 20, '2026-10-05', [ctx.mei.id]],
      ['Cherries', 'done', 12, null, []],
      ['Dates', 'todo', null, '2026-11-01', [ctx.lin.id]],
      ['Elderberries', null, 7, '2026-10-03', []],
    ];
    const made = await ctx.as(ctx.lin).post(`/api/tables/tables/${table.id}/records/bulk`, {
      items: rows.map(([title, state, n, day, people]) => ({
        values: { [primary.id]: title, [status.id]: state, [count.id]: n, [due.id]: day, [owner.id]: people },
      })),
    });
    expect(made.body.items.every((item: any) => item.ok)).toBe(true);
    const query = async (body: object) => {
      const result = await ctx.as(ctx.lin).post(`/api/tables/tables/${table.id}/records/query`, body);
      expect(result.status).toBe(200);
      return result.body;
    };
    const titles = async (body: object) => (await query(body)).items.map((item: any) => item.values[primary.id]);
    return { ...ctx, ...fixture, query, titles };
  }

  const where = (field: string, op: string, value?: unknown) => ({
    filter: { mode: 'and', clauses: [{ field, op, value }] },
  });

  it('filters by option, number, text, member ($me), date and emptiness; and with or', async () => {
    const { status, count, due, owner, primary, titles, mei } = await seeded();
    expect(await titles(where(status.id, 'eq', 'todo'))).toEqual(['Apples', 'Dates']);
    expect(await titles(where(status.id, 'is_empty'))).toEqual(['Elderberries']);
    expect(await titles(where(count.id, 'gt', 7))).toEqual(['Bananas', 'Cherries']);
    expect(await titles(where(count.id, 'lte', '7'))).toEqual(['Apples', 'Elderberries']);
    expect(await titles(where(primary.id, 'contains', 'err'))).toEqual(['Cherries', 'Elderberries']);
    expect(await titles(where(owner.id, 'contains', '$me'))).toEqual(['Apples', 'Dates']);
    expect(await titles(where(owner.id, 'contains', mei.id))).toEqual(['Bananas']);
    expect(await titles(where(due.id, 'lt', '2026-10-04'))).toEqual(['Apples', 'Elderberries']);
    expect(await titles(where(due.id, 'is_empty'))).toEqual(['Cherries']);
    // A clause without its value is left out rather than matching nothing.
    expect(await titles(where(status.id, 'eq'))).toHaveLength(5);
    const either = {
      filter: {
        mode: 'or',
        clauses: [
          { field: status.id, op: 'eq', value: 'done' },
          { field: count.id, op: 'gte', value: 20 },
        ],
      },
    };
    expect(await titles(either)).toEqual(['Bananas', 'Cherries']);
    // Created today, by me: every row.
    expect(await titles(where('created_at', 'eq', '$today'))).toHaveLength(5);
    expect(await titles(where('created_by', 'eq', '$me'))).toHaveLength(5);
  });

  it('sorts by option order and numbers, groups, searches, counts and pages', async () => {
    const { status, count, query, titles } = await seeded();
    expect(await titles({ sorts: [{ field: status.id }] })).toEqual([
      'Apples',
      'Dates',
      'Bananas',
      'Cherries',
      'Elderberries',
    ]);
    expect(await titles({ sorts: [{ field: count.id, desc: true }] })).toEqual([
      'Bananas',
      'Cherries',
      'Elderberries',
      'Apples',
      'Dates',
    ]);
    expect(await titles({ group: { field: status.id, desc: true }, sorts: [{ field: count.id }] })).toEqual([
      'Cherries',
      'Bananas',
      'Apples',
      'Dates',
      'Elderberries',
    ]);
    expect(await titles({ search: 'an' })).toEqual(['Bananas']);
    // An option's label counts too.
    expect(await titles({ search: 'doin' })).toEqual(['Bananas']);
    const first = await query({ limit: 2, count: true });
    expect(first.total).toBe(5);
    expect(first.items).toHaveLength(2);
    const second = await query({ limit: 2, cursor: first.next_cursor });
    expect(second.items).toHaveLength(2);
    const third = await query({ limit: 2, cursor: second.next_cursor });
    expect(third.items).toHaveLength(1);
    expect(third.next_cursor).toBeNull();
  });

  it('pastes many records at once: each change succeeds or fails on its own', async () => {
    const { lin, as, table, primary, count, query } = await seeded();
    const { items } = await query({ limit: 2 });
    const pasted = await as(lin).post(`/api/tables/tables/${table.id}/records/bulk`, {
      items: [
        { id: items[0].id, revision: items[0].revision, values: { [count.id]: 100 } },
        { id: items[1].id, revision: items[1].revision + 5, values: { [count.id]: 200 } },
        { values: { [primary.id]: 'Figs', [count.id]: 'x' } },
        { values: { [primary.id]: 'Grapes' } },
      ],
    });
    expect(pasted.body.items.map((item: any) => item.ok)).toEqual([true, false, false, true]);
    expect(pasted.body.items[1].code).toBe('stale_revision');
    expect(pasted.body.items[2].code).toBe('invalid_input');
    expect(pasted.body.items[0].record.values[count.id]).toBe(100);
    expect((await query({ count: true })).total).toBe(6);
  });

  it('moves deleted records to the recycle bin, restores them and deletes them for good', async () => {
    const { lin, mei, as, base, table, query } = await seeded();
    const { items } = await query({ limit: 3 });
    const deleted = await as(lin).post(`/api/tables/tables/${table.id}/records/delete`, {
      ids: [items[0].id, items[1].id],
    });
    expect(deleted.body).toEqual({ deleted: 2 });
    expect((await query({ count: true })).total).toBe(3);
    const bin = await as(lin).get(`/api/tables/bases/${base.id}/trash`);
    expect(bin.body.items.map((item: any) => [item.kind, item.name]).sort()).toEqual([
      ['record', 'Apples'],
      ['record', 'Bananas'],
    ]);
    expect(bin.body.items[0].deleted_by).toEqual({ id: lin.id, name: 'Lin' });
    expect((await as(lin).post(`/api/tables/records/${items[0].id}/restore`)).status).toBe(200);
    expect((await query({ count: true })).total).toBe(4);
    // A viewer neither sees the bin nor deletes for good; a builder does.
    await as(lin).put(`/api/tables/bases/${base.id}/share`, {
      items: [{ type: 'member', id: mei.id, role: 'viewer' }],
    });
    expect((await as(mei).get(`/api/tables/bases/${base.id}/trash`)).status).toBe(403);
    expect((await as(lin).post(`/api/tables/records/${items[1].id}/purge`)).status).toBe(204);
    expect((await as(lin).get(`/api/tables/records/${items[1].id}`)).status).toBe(404);
    const after = await as(lin).get(`/api/tables/bases/${base.id}/trash`);
    expect(after.body.items.filter((item: any) => item.kind === 'record')).toEqual([]);
  });

  it('exports a view as CSV with its filter, order and visible fields', async () => {
    const { lin, app, base, table, primary, status, count, due } = await seeded();
    const grid = base.views[0];
    await app.call('PATCH', `/api/tables/views/${grid.id}`, {
      token: lin.token,
      body: {
        revision: grid.revision,
        config: {
          filter: { mode: 'and', clauses: [{ field: status.id, op: 'eq', value: 'todo' }] },
          sorts: [{ field: primary.id, desc: true }],
          hidden: [due.id],
          order: [count.id, status.id],
        },
      },
    });
    const response = await app.app.request(`/api/tables/tables/${table.id}/export?view_id=${grid.id}`, {
      headers: { authorization: `Bearer ${lin.token}` },
    });
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('content-disposition')).toContain('.csv');
    const lines = (await response.text()).replace(/^\uFEFF/, '').split('\r\n');
    expect(lines).toEqual(['名称,Count,Status,Owner', 'Dates,,To do,Lin', 'Apples,5,To do,Lin', '']);
  });
});

describe('sharing', () => {
  it('gives a viewer read access only, an editor records, a builder structure; groups and everyone too', async () => {
    const { lin, mei, person, as, listen } = await setup();
    const kai = await person('Kai');
    const { base, table, primary } = await blank(as(lin));
    const rec = (await as(lin).post(`/api/tables/tables/${table.id}/records`, { values: { [primary.id]: 'One' } })).body
      .record;

    // Groups and the workspace cannot build or own.
    const bad = await as(lin).put(`/api/tables/bases/${base.id}/share`, {
      items: [{ type: 'workspace', role: 'builder' }],
    });
    expect(bad.status).toBe(400);
    const events = listen(mei);
    const shared = await as(lin).put(`/api/tables/bases/${base.id}/share`, {
      items: [{ type: 'member', id: mei.id, role: 'viewer' }],
    });
    expect(shared.body).toMatchObject({
      owner: { id: lin.id, name: 'Lin' },
      items: [{ type: 'member', id: mei.id, name: 'Mei', role: 'viewer' }],
    });
    expect(events.some((event) => event.type === 'base.updated')).toBe(true);
    const told = await getDb().select().from(notifications).where(eq(notifications.memberId, mei.id));
    expect(told).toEqual([expect.objectContaining({ kind: 'share', targetType: 'base', targetId: base.id })]);

    expect((await as(mei).get(`/api/tables/bases/${base.id}`)).body.access).toBe('viewer');
    expect((await as(mei).post(`/api/tables/tables/${table.id}/records/query`, {})).body.items).toHaveLength(1);
    const write = await as(mei).patch(`/api/tables/records/${rec.id}`, {
      revision: 1,
      values: { [primary.id]: 'Two' },
    });
    expect(write.status).toBe(403);
    expect((await as(mei).post(`/api/tables/tables/${table.id}/records`, { values: {} })).status).toBe(403);
    expect((await as(mei).post(`/api/tables/tables/${table.id}/fields`, { name: 'X', type: 'text' })).status).toBe(403);
    expect((await as(mei).put(`/api/tables/bases/${base.id}/share`, { items: [] })).status).toBe(403);
    // Anyone who reads may comment.
    expect((await as(mei).post(`/api/tables/records/${rec.id}/comments`, { body: 'Looks good' })).status).toBe(201);

    // Through a group, as an editor.
    const groupId = newId('group');
    await getDb().insert(groups).values({ id: groupId, name: 'Ops' });
    await getDb().insert(groupMembers).values({ groupId, memberId: kai.id });
    expect((await as(kai).get(`/api/tables/bases/${base.id}`)).status).toBe(404);
    await as(lin).put(`/api/tables/bases/${base.id}/share`, {
      items: [
        { type: 'member', id: mei.id, role: 'builder' },
        { type: 'group', id: groupId, role: 'editor' },
      ],
    });
    expect((await as(kai).get(`/api/tables/bases/${base.id}`)).body.access).toBe('editor');
    const kaiWrite = await as(kai).patch(`/api/tables/records/${rec.id}`, {
      revision: 1,
      values: { [primary.id]: 'Two' },
    });
    expect(kaiWrite.status).toBe(200);
    expect((await as(kai).post(`/api/tables/tables/${table.id}/fields`, { name: 'X', type: 'text' })).status).toBe(403);
    expect((await as(mei).post(`/api/tables/tables/${table.id}/fields`, { name: 'X', type: 'text' })).status).toBe(201);
    // A builder is not an owner.
    expect((await as(mei).post(`/api/tables/bases/${base.id}/archive`)).status).toBe(403);

    // Everyone, as viewers; the owner stays the owner.
    await as(lin).put(`/api/tables/bases/${base.id}/share`, { items: [{ type: 'workspace', role: 'viewer' }] });
    expect((await as(kai).get(`/api/tables/bases/${base.id}`)).body.access).toBe('viewer');
    expect((await as(lin).get(`/api/tables/bases/${base.id}`)).body.access).toBe('owner');
    const audited = await getDb().select().from(auditEvents).where(eq(auditEvents.resourceId, base.id));
    expect(audited.filter((row) => row.action === 'base.share')).toHaveLength(3);
    // An admin gets nothing for being an admin.
    const admin = await person('Ada', 'admin');
    await as(lin).put(`/api/tables/bases/${base.id}/share`, { items: [] });
    expect((await as(admin).get(`/api/tables/bases/${base.id}`)).status).toBe(404);
  });
});

describe('comments, files and search', () => {
  it('tells the people a comment mentions, and lists comments with the history', async () => {
    const { lin, mei, as } = await setup();
    const { base, table, primary } = await blank(as(lin));
    await as(lin).put(`/api/tables/bases/${base.id}/share`, {
      items: [{ type: 'member', id: mei.id, role: 'editor' }],
    });
    const rec = (await as(lin).post(`/api/tables/tables/${table.id}/records`, { values: { [primary.id]: 'Plan' } }))
      .body.record;
    const comment = await as(lin).post(`/api/tables/records/${rec.id}/comments`, {
      body: `Can you check this, [@Mei](member:${mei.id})?`,
    });
    expect(comment.body).toMatchObject({ target_type: 'record', target_id: rec.id, mentions: [mei.id], mine: true });
    const told = await getDb().select().from(notifications).where(eq(notifications.memberId, mei.id));
    expect(told.filter((row) => row.kind === 'mention')).toEqual([
      expect.objectContaining({ targetType: 'record', targetId: rec.id, title: 'Lin 在「Plan」的评论里提到了你' }),
    ]);
    // Mei's comment tells the record's creator.
    await as(mei).post(`/api/tables/records/${rec.id}/comments`, { body: 'Done.' });
    const linTold = await getDb().select().from(notifications).where(eq(notifications.memberId, lin.id));
    expect(linTold.map((row) => row.kind)).toEqual(['comment']);
    const activity = await as(lin).get(`/api/tables/records/${rec.id}/activity`);
    expect(activity.body.items.map((item: any) => item.kind)).toEqual(['comment', 'comment', 'event']);
    // Only its writer edits a comment; the owner may remove any.
    const meiComment = activity.body.items[0];
    expect((await as(lin).patch(`/api/tables/records/${rec.id}/comments/${meiComment.id}`, { body: 'x' })).status).toBe(
      403,
    );
    expect((await as(lin).del(`/api/tables/records/${rec.id}/comments/${meiComment.id}`)).status).toBe(204);
    const paged = await as(lin).get(`/api/tables/records/${rec.id}/activity?limit=1`);
    expect(paged.body.items).toHaveLength(1);
    const next = await as(lin).get(`/api/tables/records/${rec.id}/activity?limit=1&cursor=${paged.body.next_cursor}`);
    expect(next.body.items[0].kind).toBe('event');
  });

  it('attaches files uploaded to the base, readable by those who read the base', async () => {
    const { lin, mei, person, as, app } = await setup();
    const kai = await person('Kai');
    const { base, table, primary } = await blank(as(lin));
    const files = (await as(lin).post(`/api/tables/tables/${table.id}/fields`, { name: 'Files', type: 'attachment' }))
      .body;
    const upload = async (who: Who, name: string) => {
      const form = new FormData();
      form.set('file', new File(['hello'], name, { type: 'text/plain' }));
      const response = await app.app.request(`/api/tables/bases/${base.id}/files`, {
        method: 'POST',
        headers: { authorization: `Bearer ${who.token}` },
        body: form,
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    const file = await upload(lin, 'notes.txt');
    expect(file.status).toBe(201);
    const rec = (
      await as(lin).post(`/api/tables/tables/${table.id}/records`, {
        values: { [primary.id]: 'With file', [files.id]: [file.body.id] },
      })
    ).body;
    expect(rec.record.values[files.id]).toEqual([file.body.id]);
    expect(rec.files[file.body.id]).toMatchObject({ name: 'notes.txt', size_bytes: 5 });
    // Someone else's upload, or a file of another record, cannot be attached.
    await as(lin).put(`/api/tables/bases/${base.id}/share`, {
      items: [{ type: 'member', id: mei.id, role: 'editor' }],
    });
    const other = await as(mei).post(`/api/tables/tables/${table.id}/records`, {
      values: { [files.id]: [file.body.id] },
    });
    expect(other.status).toBe(400);
    // Mei reads it through the base; Kai cannot.
    const seen = await as(mei).get(`/api/files/${file.body.id}`);
    expect(seen.status).toBe(200);
    expect((await as(kai).get(`/api/files/${file.body.id}`)).status).toBe(404);
    const signed = await app.app.request(seen.body.url);
    expect(await signed.text()).toBe('hello');
  });

  it('finds records by their words in ⌘K, only in bases the member may read', async () => {
    const { lin, mei, as } = await setup();
    const { base, table, primary } = await blank(as(lin));
    await as(lin).post(`/api/tables/tables/${table.id}/records`, { values: { [primary.id]: '季度预算评审' } });
    const hits = await as(lin).get(`/api/search?q=${encodeURIComponent('预算')}&kinds=records`);
    expect(hits.body.items).toEqual([
      expect.objectContaining({ kind: 'records', title: '季度预算评审', base_id: base.id, table_id: table.id }),
    ]);
    const none = await as(mei).get(`/api/search?q=${encodeURIComponent('预算')}&kinds=records`);
    expect(none.body.items).toEqual([]);
  });
});
