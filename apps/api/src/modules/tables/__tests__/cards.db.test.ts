/** Dashboards (TBL-13): making them, keeping their cards to the base, and what each card shows whom. */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  cardDataSchema,
  dashboardDataSchema,
  viewSchema,
  zonedDay,
  type Card,
  type TokenPair,
} from '@greenhouse/contract';
import { createApiClient } from '@greenhouse/contract/client';
import { baseRoles, getDb, members, newId } from '@greenhouse/db';
import { createTestApp, TEST_PASSWORD } from '../../../testing.js';

type App = ReturnType<typeof createTestApp>;
type Who = Awaited<ReturnType<App['member']>>;

async function setup() {
  const app = createTestApp({ STORAGE_PROVIDER: 'local', STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'gh-cards-')) });
  const person = async (name: string, email?: string) => {
    const who = await app.member('member', email);
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
  return { app, lin, mei, person, as };
}
type As = ReturnType<Awaited<ReturnType<typeof setup>>['as']>;

/** A base whose first table has a field of each kind a card reads. */
async function blank(as: As, name = 'Inventory') {
  const base = (await as.post('/api/tables/bases', { name })).body;
  const table = base.tables[0];
  const field = async (body: object) => {
    const made = await as.post(`/api/tables/tables/${table.id}/fields`, body);
    expect(made.status).toBe(201);
    return made.body as { id: string; name: string };
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
  const at = await field({ name: 'At', type: 'datetime' });
  const done = await field({ name: 'Done', type: 'checkbox' });
  const notes = await field({ name: 'Notes', type: 'long_text' });
  const tags = await field({
    name: 'Tags',
    type: 'multi_select',
    config: { options: [{ id: 'red', label: 'Red', color: 'red' }] },
  });
  return { base, table, primary: table.fields[0] as { id: string }, status, count, due, owner, at, done, notes, tags };
}
type Blank = Awaited<ReturnType<typeof blank>>;

/**
 * Six records: A to do 5 (Jan 10, Lin), B to do 3 (Jan 20, Mei), C doing 10 (Mar 4, Lin),
 * D done 2 (Mar 8, Lin, checked), E with nothing, F done 7 (May 10, Mei, checked). A and B have a
 * time: 17:30 and 10:00 UTC on Mar 1, which in Shanghai are Mar 2 01:30 and Mar 1 18:00.
 */
async function records(as: As, t: Blank, lin: Who, mei: Who) {
  const rows = [
    { name: 'A', status: 'todo', count: 5, due: '2026-01-10', owner: [lin.id], at: '2026-03-01T17:30:00.000Z' },
    { name: 'B', status: 'todo', count: 3, due: '2026-01-20', owner: [mei.id], at: '2026-03-01T10:00:00.000Z' },
    { name: 'C', status: 'doing', count: 10, due: '2026-03-04', owner: [lin.id] },
    { name: 'D', status: 'done', count: 2, due: '2026-03-08', owner: [lin.id], done: true },
    { name: 'E' },
    { name: 'F', status: 'done', count: 7, due: '2026-05-10', owner: [mei.id], done: true },
  ] as Array<Record<string, unknown>>;
  const ids: Record<string, string> = {
    name: t.primary.id,
    status: t.status.id,
    count: t.count.id,
    due: t.due.id,
    owner: t.owner.id,
    at: t.at.id,
    done: t.done.id,
  };
  const made = await as.post(`/api/tables/tables/${t.table.id}/records/bulk`, {
    items: rows.map((row) => ({ values: Object.fromEntries(Object.entries(row).map(([key, v]) => [ids[key], v])) })),
  });
  expect(made.body.items.map((item: { ok: boolean }) => item.ok)).toEqual([true, true, true, true, true, true]);
}

/** Makes a dashboard and saves these cards on it. */
async function dashboardWith(as: As, baseId: string, cards: object[], body: object = { name: 'Overview' }) {
  const made = await as.post(`/api/tables/bases/${baseId}/dashboards`, body);
  expect(made.status).toBe(201);
  const saved = await as.patch(`/api/tables/views/${made.body.id}`, {
    revision: made.body.revision,
    config: { cards },
  });
  expect(saved.status).toBe(200);
  return saved.body as { id: string; revision: number; config: { cards: Card[] } };
}

/** What every card of a dashboard shows, by card id. */
async function shown(as: As, viewId: string) {
  const answer = await as.get(`/api/tables/views/${viewId}/cards`);
  expect(answer.status).toBe(200);
  const parsed = dashboardDataSchema.parse(answer.body);
  return Object.fromEntries(parsed.items.map((item) => [item.id, item.data]));
}

const card = (id: string, kind: Card['kind'], tableId: string, rest: Partial<Card> = {}) => ({
  id,
  kind,
  title: '',
  table_id: tableId,
  ...rest,
});

describe('dashboards', () => {
  it('makes shared dashboards for builders and personal ones for anyone who sees the base', async () => {
    const { lin, mei, as } = await setup();
    const { base, table } = await blank(as(lin));
    await as(lin).put(`/api/tables/bases/${base.id}/share`, {
      items: [{ type: 'member', id: mei.id, role: 'viewer' }],
    });
    const shared = await as(lin).post(`/api/tables/bases/${base.id}/dashboards`, { name: 'Overview' });
    expect(shared.status).toBe(201);
    expect(viewSchema.parse(shared.body)).toMatchObject({
      table_id: null,
      name: 'Overview',
      type: 'dashboard',
      personal: false,
      config: { cards: [] },
      position: 0,
      editable: true,
    });
    const refused = await as(mei).post(`/api/tables/bases/${base.id}/dashboards`, { name: 'Mine' });
    expect(refused).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
    const mine = await as(mei).post(`/api/tables/bases/${base.id}/dashboards`, { name: 'Mine', personal: true });
    expect(mine.body).toMatchObject({ personal: true, editable: true, position: 1 });

    // Lin does not see Mei's; Mei sees both, and only hers is hers to change.
    const dashboardsOf = (detail: { views: Array<{ type: string; name: string; editable: boolean }> }) =>
      detail.views.filter((view) => view.type === 'dashboard').map((view) => [view.name, view.editable]);
    expect(dashboardsOf((await as(lin).get(`/api/tables/bases/${base.id}`)).body)).toEqual([['Overview', true]]);
    expect(dashboardsOf((await as(mei).get(`/api/tables/bases/${base.id}`)).body)).toEqual([
      ['Overview', false],
      ['Mine', true],
    ]);
    expect((await as(mei).get('/api/tables/bases')).body.items[0].dashboards).toEqual([
      { id: shared.body.id, name: 'Overview', personal: false },
      { id: mine.body.id, name: 'Mine', personal: true },
    ]);

    // A viewer cannot change or delete the shared one; their own they can.
    const number = card('n', 'number', table.id);
    expect(
      (await as(mei).patch(`/api/tables/views/${shared.body.id}`, { revision: 1, config: { cards: [number] } })).status,
    ).toBe(403);
    expect((await as(mei).del(`/api/tables/views/${shared.body.id}`)).status).toBe(403);
    const changed = await as(mei).patch(`/api/tables/views/${mine.body.id}`, {
      revision: mine.body.revision,
      name: 'My numbers',
      config: { cards: [number] },
    });
    expect(changed.body).toMatchObject({ name: 'My numbers', config: { cards: [number] }, revision: 2 });
    expect(await shown(as(mei), mine.body.id)).toEqual({ n: { kind: 'number', value: 0, records: 0 } });

    // Lin cannot reach Mei's personal dashboard; a grid has no cards.
    expect((await as(lin).get(`/api/tables/views/${mine.body.id}/cards`)).status).toBe(404);
    expect((await as(lin).get(`/api/tables/views/${base.views[0].id}/cards`)).status).toBe(404);
    expect((await as(lin).del(`/api/tables/views/${shared.body.id}`)).status).toBe(204);
    expect(dashboardsOf((await as(mei).get(`/api/tables/bases/${base.id}`)).body)).toEqual([['My numbers', true]]);
  });

  it('keeps cards to the base: fields that are gone drop out, other bases and misfits are refused', async () => {
    const { lin, as } = await setup();
    const t = await blank(as(lin));
    const other = await blank(as(lin), 'Elsewhere');
    const made = (await as(lin).post(`/api/tables/bases/${t.base.id}/dashboards`, { name: 'Checks' })).body;
    let revision = made.revision as number;
    const save = (cards: object[]) => as(lin).patch(`/api/tables/views/${made.id}`, { revision, config: { cards } });
    const saved = async (cards: object[]) => {
      const answer = await save(cards);
      expect(answer.status).toBe(200);
      revision = answer.body.revision;
      return answer.body.config.cards as Card[];
    };
    const byStatus = card('bar', 'bar', t.table.id, {
      title: 'By status',
      filter: { mode: 'and', clauses: [{ field: t.count.id, op: 'gt', value: 0 }] },
      measure: { aggregate: 'sum', field: t.count.id },
      group: { field: t.status.id, limit: 5 },
      // A list's settings mean nothing on a chart.
      list: { fields: [t.count.id] },
      size: 'large',
    });
    const latest = card('list', 'list', t.table.id, {
      title: 'Latest',
      measure: { aggregate: 'count' },
      list: { fields: [t.primary.id, t.status.id, t.count.id, t.status.id], sorts: [{ field: t.due.id, desc: true }] },
    });
    const byDue = card('due', 'line', t.table.id, { group: { field: t.due.id } });
    expect(await saved([byStatus, latest, byDue])).toEqual([
      {
        id: 'bar',
        kind: 'bar',
        title: 'By status',
        table_id: t.table.id,
        filter: { mode: 'and', clauses: [{ field: t.count.id, op: 'gt', value: 0 }] },
        measure: { aggregate: 'sum', field: t.count.id },
        group: { field: t.status.id, limit: 5 },
        size: 'large',
      },
      {
        id: 'list',
        kind: 'list',
        title: 'Latest',
        table_id: t.table.id,
        list: { fields: [t.status.id, t.count.id], sorts: [{ field: t.due.id, desc: true }] },
      },
      // Dates take a bucket.
      { id: 'due', kind: 'line', title: '', table_id: t.table.id, group: { field: t.due.id, bucket: 'day' } },
    ]);
    const late = await as(lin).patch(`/api/tables/views/${made.id}`, {
      revision: made.revision,
      config: { cards: [] },
    });
    expect(late).toMatchObject({ status: 409, body: { error: { code: 'stale_revision' } } });

    // A field deleted to the recycle bin leaves the cards that named it when they are saved again;
    // the sum that lost its field is kept and says it is incomplete.
    expect((await as(lin).del(`/api/tables/fields/${t.count.id}`)).status).toBe(204);
    expect(await saved([byStatus, latest, byDue])).toEqual([
      {
        id: 'bar',
        kind: 'bar',
        title: 'By status',
        table_id: t.table.id,
        measure: { aggregate: 'sum' },
        group: { field: t.status.id, limit: 5 },
        size: 'large',
      },
      {
        id: 'list',
        kind: 'list',
        title: 'Latest',
        table_id: t.table.id,
        list: { fields: [t.status.id], sorts: [{ field: t.due.id, desc: true }] },
      },
      { id: 'due', kind: 'line', title: '', table_id: t.table.id, group: { field: t.due.id, bucket: 'day' } },
    ]);
    expect((await shown(as(lin), made.id)).bar).toEqual({ kind: 'error', code: 'incomplete' });

    const refused = async (cards: object[], id: string) => {
      const answer = await save(cards);
      expect(answer.status).toBe(400);
      expect(answer.body.error).toMatchObject({ code: 'invalid_input', details: { card: id } });
    };
    // Another base's table, the same id twice, a sum of text, a group by long text or by the last
    // editor, a bucket on an option field, an operator the field does not take, a sort by a list.
    await refused([card('x', 'number', other.table.id)], 'x');
    await refused([card('a', 'number', t.table.id), card('a', 'pie', t.table.id)], 'a');
    await refused([card('s', 'number', t.table.id, { measure: { aggregate: 'sum', field: t.primary.id } })], 's');
    await refused([card('g', 'pie', t.table.id, { group: { field: t.notes.id } })], 'g');
    await refused([card('u', 'bar', t.table.id, { group: { field: 'updated_by' } })], 'u');
    await refused([card('b', 'bar', t.table.id, { group: { field: t.status.id, bucket: 'month' } })], 'b');
    await refused(
      [
        card('f', 'number', t.table.id, {
          filter: { mode: 'and', clauses: [{ field: t.status.id, op: 'gt', value: 'todo' }] },
        }),
      ],
      'f',
    );
    await refused([card('m', 'bar', t.table.id, { group: { field: t.tags.id } })], 'm');
    await refused([card('l', 'list', t.table.id, { list: { fields: [], sorts: [{ field: t.tags.id }] } })], 'l');
    // Nothing was saved by the refusals.
    expect(
      (await as(lin).get(`/api/tables/bases/${t.base.id}`)).body.views.find((v: any) => v.id === made.id),
    ).toMatchObject({ revision });
    // A card whose table is not there at all goes, like a field that is gone.
    expect(await saved([card('lost', 'number', 'tbl_gone'), card('n', 'number', t.table.id)])).toEqual([
      card('n', 'number', t.table.id),
    ]);
  });

  it('counts, adds up, groups and lists records in SQL', async () => {
    const { lin, mei, as } = await setup();
    const t = await blank(as(lin));
    await records(as(lin), t, lin, mei);
    const id = t.table.id;
    const view = await dashboardWith(as(lin), t.base.id, [
      card('count', 'number', id),
      card('sum', 'number', id, { measure: { aggregate: 'sum', field: t.count.id } }),
      card('avg', 'number', id, { measure: { aggregate: 'avg', field: t.count.id } }),
      card('min', 'number', id, { measure: { aggregate: 'min', field: t.count.id } }),
      card('max', 'number', id, { measure: { aggregate: 'max', field: t.count.id } }),
      card('status', 'bar', id, { group: { field: t.status.id } }),
      card('statusSum', 'bar', id, { group: { field: t.status.id }, measure: { aggregate: 'sum', field: t.count.id } }),
      card('owner', 'bar', id, { group: { field: t.owner.id } }),
      card('month', 'line', id, { group: { field: t.due.id, bucket: 'month' } }),
      card('week', 'bar', id, { group: { field: t.due.id, bucket: 'week', limit: 3 } }),
      card('quarter', 'line', id, { group: { field: t.due.id, bucket: 'quarter' } }),
      card('atDay', 'bar', id, { group: { field: t.at.id, bucket: 'day' } }),
      card('created', 'line', id, { group: { field: 'created_at', bucket: 'week' } }),
      card('done', 'pie', id, { group: { field: t.done.id } }),
      card('top', 'pie', id, { group: { field: t.status.id, limit: 2 } }),
      card('list', 'list', id, {
        list: { fields: [t.status.id, t.count.id], sorts: [{ field: t.count.id, desc: true }], limit: 2 },
      }),
    ]);
    const data = await shown(as(lin), view.id);

    expect(data.count).toEqual({ kind: 'number', value: 6, records: 6 });
    expect(data.sum).toEqual({ kind: 'number', value: 27, records: 6 });
    expect(data.avg).toEqual({ kind: 'number', value: 5.4, records: 6 });
    expect(data.min).toEqual({ kind: 'number', value: 2, records: 6 });
    expect(data.max).toEqual({ kind: 'number', value: 10, records: 6 });

    // Options in the field's order with their labels and colours; the empty group last.
    expect(data.status).toEqual({
      kind: 'groups',
      key_type: 'option',
      groups: [
        { key: 'todo', label: 'To do', color: 'gray', value: 2, records: 2 },
        { key: 'doing', label: 'Doing', color: 'blue', value: 1, records: 1 },
        { key: 'done', label: 'Done', color: 'green', value: 2, records: 2 },
        { key: null, label: '', value: 1, records: 1 },
      ],
      other: null,
      records: 6,
    });
    expect(data.statusSum).toMatchObject({
      groups: [
        { key: 'todo', value: 8 },
        { key: 'doing', value: 10 },
        { key: 'done', value: 9 },
        { key: null, value: 0 },
      ],
    });
    // Members by their figure, with their names.
    expect(data.owner).toMatchObject({
      key_type: 'member',
      groups: [
        { key: lin.id, label: 'Lin', value: 3 },
        { key: mei.id, label: 'Mei', value: 2 },
        { key: null, label: '', value: 1 },
      ],
    });
    // Months oldest first, the empty ones in between.
    expect(data.month).toEqual({
      kind: 'groups',
      key_type: 'date',
      bucket: 'month',
      groups: [
        { key: '2026-01-01', label: '', value: 2, records: 2 },
        { key: '2026-02-01', label: '', value: 0, records: 0 },
        { key: '2026-03-01', label: '', value: 2, records: 2 },
        { key: '2026-04-01', label: '', value: 0, records: 0 },
        { key: '2026-05-01', label: '', value: 1, records: 1 },
        { key: null, label: '', value: 1, records: 1 },
      ],
      other: null,
      records: 6,
    });
    // Weeks start on Monday; three weeks back from the latest, the earlier ones added up.
    expect(data.week).toMatchObject({
      bucket: 'week',
      groups: [
        { key: '2026-04-20', value: 0 },
        { key: '2026-04-27', value: 0 },
        { key: '2026-05-04', value: 1 },
        { key: null, value: 1 },
      ],
      other: { value: 4, records: 4 },
      records: 6,
    });
    expect(data.quarter).toMatchObject({
      groups: [
        { key: '2026-01-01', value: 4 },
        { key: '2026-04-01', value: 1 },
        { key: null, value: 1 },
      ],
    });
    // Times fall on the reader's days: 17:30 UTC on Mar 1 is Mar 2 in Shanghai.
    expect(data.atDay).toMatchObject({
      groups: [
        { key: '2026-03-01', value: 1 },
        { key: '2026-03-02', value: 1 },
        { key: null, value: 4 },
      ],
    });
    const today = zonedDay(new Date().toISOString(), 'Asia/Shanghai');
    const monday = new Date(`${today}T00:00:00.000Z`);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    expect(data.created).toMatchObject({ groups: [{ key: monday.toISOString().slice(0, 10), value: 6 }] });
    expect(data.done).toMatchObject({
      key_type: 'checkbox',
      groups: [
        { key: 'true', value: 2 },
        { key: 'false', value: 4 },
      ],
    });
    // The two largest groups, the rest added up.
    expect(data.top).toMatchObject({
      groups: [
        { key: 'todo', value: 2 },
        { key: 'done', value: 2 },
      ],
      other: { value: 2, records: 2 },
      records: 6,
    });

    // The first records in the card's order, with only its fields.
    const list = data.list!;
    expect(list).toMatchObject({
      kind: 'list',
      title_field: t.primary.id,
      fields: [t.status.id, t.count.id],
      records: 6,
    });
    if (list.kind !== 'list') throw new Error('not a list');
    expect(list.items.map((item) => item.values)).toEqual([
      { [t.primary.id]: 'C', [t.status.id]: 'doing', [t.count.id]: 10 },
      { [t.primary.id]: 'F', [t.status.id]: 'done', [t.count.id]: 7 },
    ]);

    // One card, saved or not, answers the same.
    const one = await as(lin).post('/api/tables/cards/query', {
      card: card('q', 'bar', id, { group: { field: t.status.id } }),
    });
    expect(cardDataSchema.parse(one.body)).toEqual(data.status);
    const bad = await as(lin).post('/api/tables/cards/query', { card: { id: 'q', kind: 'chart' } });
    expect(bad).toMatchObject({ status: 400, body: { error: { code: 'invalid_input' } } });
  });

  it("works out a card's filter for each reader: $me is them, days are theirs", async () => {
    const { lin, mei, as } = await setup();
    const t = await blank(as(lin));
    await records(as(lin), t, lin, mei);
    await as(lin).put(`/api/tables/bases/${t.base.id}/share`, {
      items: [{ type: 'member', id: mei.id, role: 'viewer' }],
    });
    const view = await dashboardWith(as(lin), t.base.id, [
      card('mine', 'number', t.table.id, {
        filter: { mode: 'and', clauses: [{ field: t.owner.id, op: 'contains', value: '$me' }] },
      }),
      card('mineDone', 'bar', t.table.id, {
        filter: {
          mode: 'and',
          clauses: [
            { field: t.owner.id, op: 'contains', value: '$me' },
            { field: t.done.id, op: 'eq', value: true },
          ],
        },
        group: { field: t.status.id },
      }),
      card('created', 'number', t.table.id, {
        filter: { mode: 'and', clauses: [{ field: 'created_at', op: 'eq', value: '$today' }] },
      }),
      card('onMar2', 'list', t.table.id, {
        filter: { mode: 'and', clauses: [{ field: t.at.id, op: 'eq', value: '2026-03-02' }] },
      }),
    ]);
    const forLin = await shown(as(lin), view.id);
    const forMei = await shown(as(mei), view.id);
    expect(forLin.mine).toEqual({ kind: 'number', value: 3, records: 3 });
    expect(forMei.mine).toEqual({ kind: 'number', value: 2, records: 2 });
    expect(forLin.mineDone).toMatchObject({ groups: [{ key: 'done', value: 1 }] });
    expect(forMei.mineDone).toMatchObject({ groups: [{ key: 'done', value: 1 }] });
    expect(forLin.created).toEqual({ kind: 'number', value: 6, records: 6 });
    expect(forLin.onMar2).toMatchObject({ kind: 'list', records: 1, fields: [] });
    if (forLin.onMar2?.kind !== 'list') throw new Error('not a list');
    expect(forLin.onMar2.items.map((item) => item.values[t.primary.id])).toEqual(['A']);
  });

  it('shows a custom role only its records, and never works out a card on a field it does not see', async () => {
    const { lin, mei, as } = await setup();
    const t = await blank(as(lin));
    await records(as(lin), t, lin, mei);
    // Mei sees the records she owns, without Count.
    const [role] = await getDb()
      .insert(baseRoles)
      .values({
        id: newId('baseRole'),
        baseId: t.base.id,
        name: 'Own records',
        rules: {
          tables: {
            [t.table.id]: {
              access: 'read',
              rows: { mode: 'and', clauses: [{ field: t.owner.id, op: 'contains', value: '$me' }] },
              hidden_fields: [t.count.id],
            },
          },
        },
      })
      .returning();
    const shared = await as(lin).put(`/api/tables/bases/${t.base.id}/share`, {
      items: [{ type: 'member', id: mei.id, role: 'custom', custom_role_id: role!.id }],
    });
    expect(shared.status).toBe(200);
    const id = t.table.id;
    const view = await dashboardWith(as(lin), t.base.id, [
      card('count', 'number', id),
      card('sum', 'number', id, { measure: { aggregate: 'sum', field: t.count.id } }),
      card('status', 'bar', id, { group: { field: t.status.id } }),
      card('byCount', 'number', id, { filter: { mode: 'and', clauses: [{ field: t.count.id, op: 'gt', value: 0 }] } }),
      card('list', 'list', id, {
        list: { fields: [t.status.id, t.count.id], sorts: [{ field: t.count.id, desc: true }] },
      }),
    ]);
    const forLin = await shown(as(lin), view.id);
    const forMei = await shown(as(mei), view.id);
    expect(forLin.count).toEqual({ kind: 'number', value: 6, records: 6 });
    expect(forMei.count).toEqual({ kind: 'number', value: 2, records: 2 });
    expect(forMei.sum).toEqual({ kind: 'error', code: 'field_hidden' });
    expect(forMei.byCount).toEqual({ kind: 'error', code: 'field_hidden' });
    expect(forMei.status).toMatchObject({
      groups: [
        { key: 'todo', value: 1 },
        { key: 'done', value: 1 },
      ],
      records: 2,
    });
    // Count is left out of the list, and so is the order by it.
    expect(forMei.list).toMatchObject({ fields: [t.status.id], records: 2 });
    if (forMei.list?.kind !== 'list') throw new Error('not a list');
    expect(forMei.list.items.map((item) => item.values)).toEqual([
      { [t.primary.id]: 'B', [t.status.id]: 'todo' },
      { [t.primary.id]: 'F', [t.status.id]: 'done' },
    ]);
  });

  it('answers each card on its own: one that cannot be worked out says why, the rest still show', async () => {
    const { lin, mei, as } = await setup();
    const t = await blank(as(lin));
    await records(as(lin), t, lin, mei);
    const spare = (await as(lin).post(`/api/tables/bases/${t.base.id}/tables`, { name: 'Spare' })).body;
    const view = await dashboardWith(as(lin), t.base.id, [
      card('ok', 'number', t.table.id),
      card('noField', 'number', t.table.id, { measure: { aggregate: 'avg' } }),
      card('noGroup', 'pie', t.table.id),
      card('gone', 'bar', t.table.id, { group: { field: t.owner.id } }),
      card('goneFilter', 'number', t.table.id, {
        filter: { mode: 'and', clauses: [{ field: t.notes.id, op: 'is_empty' }] },
      }),
      card('archived', 'number', spare.id),
    ]);
    // Deleted after the cards were saved: the owner field and the spare table.
    expect((await as(lin).del(`/api/tables/fields/${t.owner.id}`)).status).toBe(204);
    expect((await as(lin).del(`/api/tables/fields/${t.notes.id}`)).status).toBe(204);
    expect((await as(lin).del(`/api/tables/tables/${spare.id}`)).status).toBe(204);
    expect(await shown(as(lin), view.id)).toEqual({
      ok: { kind: 'number', value: 6, records: 6 },
      noField: { kind: 'error', code: 'incomplete' },
      noGroup: { kind: 'error', code: 'incomplete' },
      gone: { kind: 'error', code: 'field_hidden' },
      // A filter on a field that is gone is left out, as in a view.
      goneFilter: { kind: 'number', value: 6, records: 6 },
      archived: { kind: 'error', code: 'table_hidden' },
    });
    // The card on the table in the recycle bin stays when the dashboard is saved again.
    const again = await as(lin).patch(`/api/tables/views/${view.id}`, {
      revision: view.revision,
      config: { cards: view.config.cards },
    });
    expect(again.body.config.cards.map((entry: Card) => entry.id)).toEqual([
      'ok',
      'noField',
      'noGroup',
      'gone',
      'goneFilter',
      'archived',
    ]);
    // Deleted for good, its table takes the card with it at the next save.
    expect((await as(lin).post(`/api/tables/tables/${spare.id}/purge`)).status).toBe(204);
    const purged = await as(lin).patch(`/api/tables/views/${view.id}`, {
      revision: again.body.revision,
      config: { cards: view.config.cards },
    });
    expect(purged.body.config.cards.map((entry: Card) => entry.id)).toEqual([
      'ok',
      'noField',
      'noGroup',
      'gone',
      'goneFilter',
    ]);
    // A card on a table I cannot see answers like one that is not there.
    const elsewhere = await as(mei).post('/api/tables/cards/query', { card: card('x', 'number', t.table.id) });
    expect(elsewhere.body).toEqual({ kind: 'error', code: 'table_hidden' });
  });
});

describe('client.tables.cards', () => {
  it('makes a dashboard, answers its cards and one card', async () => {
    const { app, lin, as } = await setup();
    await app.member('member', 'dash@example.com');
    let stored: TokenPair | null = null;
    const client = createApiClient({
      baseUrl: '',
      tokens: { get: () => stored, set: (tokens) => (stored = tokens) },
      fetch: (input, init) => Promise.resolve(app.app.request(String(input), init)),
    });
    await client.auth.login('dash@example.com', TEST_PASSWORD);
    const base = await client.tables.bases.create({ template: 'project' });
    const tasks = base.tables[1]!;
    const status = tasks.fields.find((field) => field.type === 'single_select' && field.name === '状态')!;
    const made = viewSchema.parse(await client.tables.cards.createDashboard(base.id, { name: '进度', personal: true }));
    expect(made).toMatchObject({ type: 'dashboard', personal: true, config: { cards: [] } });
    const cards: Card[] = [
      { id: 'total', kind: 'number', title: '任务', table_id: tasks.id },
      { id: 'byStatus', kind: 'bar', title: '状态', table_id: tasks.id, group: { field: status.id } },
    ];
    const saved = await client.tables.views.update(made.id, { revision: made.revision, config: { cards } });
    const data = dashboardDataSchema.parse(await client.tables.cards.dashboard(made.id));
    expect(data.revision).toBe(saved.revision);
    expect(data.items[0]).toEqual({ id: 'total', data: { kind: 'number', value: 9, records: 9 } });
    expect(data.items[1]!.data).toMatchObject({
      kind: 'groups',
      groups: [
        { key: 'todo', label: '待开始', value: 7 },
        { key: 'doing', label: '进行中', value: 1 },
        { key: 'done', label: '已完成', value: 1 },
      ],
    });
    expect(cardDataSchema.parse(await client.tables.cards.query(cards[1]!))).toEqual(data.items[1]!.data);
    // Someone the base is not shared with reaches none of it.
    expect((await as(lin).get(`/api/tables/views/${made.id}/cards`)).status).toBe(404);
    expect((await as(lin).post('/api/tables/cards/query', { card: cards[0] })).body).toEqual({
      kind: 'error',
      code: 'table_hidden',
    });
  });
});
