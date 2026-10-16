import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { RealtimeEvent } from '@greenhouse/contract';
import { getDb, groupMembers, groups, members, newId, notifications, shares } from '@greenhouse/db';
import { createTestApp } from '../../../testing.js';

type App = ReturnType<typeof createTestApp>;
type Who = Awaited<ReturnType<App['member']>>;

async function setup() {
  const app = createTestApp({ STORAGE_PROVIDER: 'local', STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'gh-roles-')) });
  const person = async (name: string) => {
    const who = await app.member('member');
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
  const csv = async (who: Who, tableId: string) => {
    const response = await app.app.request(`/api/tables/tables/${tableId}/export`, {
      headers: { authorization: `Bearer ${who.token}` },
    });
    return { status: response.status, lines: (await response.text()).replace(/^\uFEFF/, '').split('\r\n') };
  };
  return { app, lin, mei, person, as, csv };
}

/**
 * Deals with a cost (成本), a secret note and an owner; a second table of accounts the deals link
 * to; Lin owns the base and one deal, Mei owns another.
 */
async function sales() {
  const ctx = await setup();
  const { lin, mei, as } = ctx;
  const base = (await as(lin).post('/api/tables/bases', { name: 'Sales' })).body;
  const deals = base.tables[0];
  const field = async (tableId: string, body: object) => {
    const made = await as(lin).post(`/api/tables/tables/${tableId}/fields`, body);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return made.body;
  };
  const cost = await field(deals.id, { name: '成本', type: 'number' });
  const note = await field(deals.id, { name: 'Note', type: 'text' });
  const owner = await field(deals.id, { name: 'Owner', type: 'member' });
  const accounts = (await as(lin).post(`/api/tables/bases/${base.id}/tables`, { name: 'Accounts' })).body;
  const account = await field(deals.id, { name: 'Account', type: 'relation', config: { table_id: accounts.id } });
  const margin = await field(deals.id, { name: 'Margin', type: 'formula', config: { formula_text: '{成本} * 2' } });
  // Reads the accounts' titles through the link.
  const called = await field(deals.id, { name: 'Called', type: 'formula', config: { formula_text: '{Account} & ""' } });
  const title = deals.fields[0].id;
  const record = async (tableId: string, values: object) => {
    const made = await as(lin).post(`/api/tables/tables/${tableId}/records`, { values });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return made.body.record;
  };
  const acme = await record(accounts.id, { [accounts.fields[0].id]: 'Acme secret account' });
  const mine = await record(deals.id, {
    [title]: 'Lin deal walrus',
    [cost.id]: 900,
    [note.id]: 'confidential pelican',
    [owner.id]: [lin.id],
    [account.id]: [acme.id],
  });
  const hers = await record(deals.id, {
    [title]: 'Mei deal otter',
    [cost.id]: 300,
    [note.id]: 'quiet heron',
    [owner.id]: [mei.id],
    [account.id]: [acme.id],
  });
  const role = await as(lin).post(`/api/tables/bases/${base.id}/roles`, {
    name: '销售',
    rules: {
      tables: {
        [deals.id]: {
          access: 'edit',
          rows: { mode: 'and', clauses: [{ field: owner.id, op: 'contains', value: '$me' }] },
          hidden_fields: [cost.id, note.id],
        },
      },
    },
  });
  expect(role.status, JSON.stringify(role.body)).toBe(201);
  const shared = await as(lin).put(`/api/tables/bases/${base.id}/share`, {
    items: [{ type: 'member', id: mei.id, role: 'custom', custom_role_id: role.body.id }],
  });
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);
  return {
    ...ctx,
    base,
    deals,
    accounts,
    cost,
    note,
    owner,
    account,
    margin,
    called,
    title,
    mine,
    hers,
    acme,
    role: role.body,
  };
}

describe('custom roles', () => {
  it('are made, changed with their revision and deleted by owners only; deleting one ends its shares', async () => {
    const { lin, mei, as, base, deals, cost, role } = await sales();
    expect((await as(lin).get(`/api/tables/bases/${base.id}/roles`)).body.items).toEqual([
      expect.objectContaining({ id: role.id, name: '销售', revision: 1 }),
    ]);
    // Only owners see or change roles.
    expect((await as(mei).get(`/api/tables/bases/${base.id}/roles`)).status).toBe(403);
    expect((await as(mei).patch(`/api/tables/roles/${role.id}`, { revision: 1, name: 'x' })).status).toBe(403);
    // Names are unique; rules name this base's tables and fields; the primary field always shows.
    const clash = await as(lin).post(`/api/tables/bases/${base.id}/roles`, { name: '销售' });
    expect(clash).toMatchObject({ status: 409, body: { error: { code: 'name_taken' } } });
    const elsewhere = await as(lin).post(`/api/tables/bases/${base.id}/roles`, {
      name: 'X',
      rules: { tables: { tbl_nowhere: { access: 'read' } } },
    });
    expect(elsewhere.status).toBe(400);
    const primary = await as(lin).post(`/api/tables/bases/${base.id}/roles`, {
      name: 'Y',
      rules: { tables: { [deals.id]: { access: 'read', hidden_fields: [deals.fields[0].id] } } },
    });
    expect(primary.status).toBe(400);
    const badRule = await as(lin).post(`/api/tables/bases/${base.id}/roles`, {
      name: 'Z',
      rules: {
        tables: {
          [deals.id]: {
            access: 'read',
            rows: { mode: 'and', clauses: [{ field: cost.id, op: 'contains', value: 'x' }] },
          },
        },
      },
    });
    expect(badRule.status).toBe(400);

    const renamed = await as(lin).patch(`/api/tables/roles/${role.id}`, { revision: 1, name: '销售 A' });
    expect(renamed.body).toMatchObject({ name: '销售 A', revision: 2 });
    const stale = await as(lin).patch(`/api/tables/roles/${role.id}`, { revision: 1, name: '销售 B' });
    expect(stale).toMatchObject({
      status: 409,
      body: { error: { code: 'stale_revision', details: { role: { revision: 2 } } } },
    });

    expect((await as(mei).get(`/api/tables/bases/${base.id}`)).status).toBe(200);
    expect((await as(lin).del(`/api/tables/roles/${role.id}`)).status).toBe(204);
    expect((await as(mei).get(`/api/tables/bases/${base.id}`)).status).toBe(404);
    const left = await getDb().select().from(shares).where(eq(shares.resourceId, base.id));
    expect(left).toEqual([]);
  });

  it('show a member only the tables, fields and records of their role, wherever they read', async () => {
    const { mei, as, csv, base, deals, cost, note, owner, account, margin, called, title, mine, hers, acme } =
      await sales();
    const listed = (await as(mei).get('/api/tables/bases')).body.items;
    expect(listed).toEqual([
      expect.objectContaining({
        id: base.id,
        access: 'editor',
        custom_role: expect.objectContaining({ name: '销售' }),
        tables: [expect.objectContaining({ id: deals.id })],
      }),
    ]);
    const detail = (await as(mei).get(`/api/tables/bases/${base.id}`)).body;
    expect(detail.tables).toHaveLength(1);
    expect(detail.tables[0].access).toBe('edit');
    const seen = detail.tables[0].fields.map((field: any) => field.id);
    expect(seen).toEqual(expect.arrayContaining([title, owner.id, account.id]));
    // Hidden fields, a formula that reads one, and one that reads titles of a table she does not see, are not there.
    expect(seen).not.toContain(cost.id);
    expect(seen).not.toContain(note.id);
    expect(seen).not.toContain(margin.id);
    expect(seen).not.toContain(called.id);

    const page = await as(mei).post(`/api/tables/tables/${deals.id}/records/query`, { count: true });
    expect(page.body.total).toBe(1);
    expect(page.body.items.map((item: any) => item.id)).toEqual([hers.id]);
    expect(Object.keys(page.body.items[0].values)).not.toContain(cost.id);
    expect(Object.keys(page.body.items[0].values)).not.toContain(margin.id);
    // A table the role does not see names no titles.
    expect(page.body.linked[acme.id]).toEqual({ title: '', table_id: acme.table_id });
    // A filter or sort on a hidden field tells nothing.
    const probe = await as(mei).post(`/api/tables/tables/${deals.id}/records/query`, {
      filter: { mode: 'and', clauses: [{ field: cost.id, op: 'gt', value: 10_000 }] },
    });
    expect(probe.body.items.map((item: any) => item.id)).toEqual([hers.id]);

    expect((await as(mei).get(`/api/tables/records/${mine.id}`)).status).toBe(404);
    expect((await as(mei).get(`/api/tables/records/${mine.id}/activity`)).status).toBe(404);
    expect((await as(mei).get(`/api/tables/records/${hers.id}`)).body.record.values[cost.id]).toBeUndefined();
    expect((await as(mei).get(`/api/tables/tables/${deals.id}/titles`)).body.items).toEqual([
      { id: hers.id, title: 'Mei deal otter' },
    ]);

    // ⌘K: her record by its title, nothing by a hidden field's words or another record's title.
    const search = (q: string) => as(mei).get(`/api/search?q=${encodeURIComponent(q)}&kinds=records`);
    expect((await search('otter')).body.items.map((item: any) => item.id)).toEqual([hers.id]);
    expect((await search('walrus')).body.items).toEqual([]);
    expect((await search('heron')).body.items).toEqual([]);
    expect((await search('Acme')).body.items).toEqual([]);

    // The export has her columns and records only.
    const exported = await csv(mei, deals.id);
    expect(exported.status).toBe(200);
    expect(exported.lines[0]).toBe('名称,Owner,Account');
    expect(exported.lines.slice(1)).toEqual(['Mei deal otter,Mei,', '']);

    // History shows changes of the fields she sees only.
    const record = (await as(mei).get(`/api/tables/records/${hers.id}`)).body.record;
    expect(record.values[owner.id]).toEqual([mei.id]);
  });

  it('let a role edit only what it sees, and only inside its records', async () => {
    const { lin, mei, as, deals, cost, owner, title, mine, hers } = await sales();
    const changed = await as(mei).patch(`/api/tables/records/${hers.id}`, {
      revision: hers.revision,
      values: { [title]: 'Mei deal otter 2' },
    });
    expect(changed.status).toBe(200);
    const hidden = await as(mei).patch(`/api/tables/records/${hers.id}`, {
      revision: changed.body.record.revision,
      values: { [cost.id]: 1 },
    });
    expect(hidden).toMatchObject({ status: 400, body: { error: { code: 'invalid_input' } } });
    // A record outside her records: not there for her, in a change, a paste or a delete.
    expect(
      (await as(mei).patch(`/api/tables/records/${mine.id}`, { revision: mine.revision, values: { [title]: 'x' } }))
        .status,
    ).toBe(404);
    const pasted = await as(mei).post(`/api/tables/tables/${deals.id}/records/bulk`, {
      items: [{ id: mine.id, values: { [title]: 'x' } }],
    });
    expect(pasted.body.items).toEqual([expect.objectContaining({ ok: false, code: 'not_found' })]);
    expect((await as(mei).post(`/api/tables/tables/${deals.id}/records/delete`, { ids: [mine.id] })).body).toEqual({
      deleted: 0,
    });
    // She cannot put a record where she would not see it.
    const outside = await as(mei).post(`/api/tables/tables/${deals.id}/records`, {
      values: { [title]: 'For Lin', [owner.id]: [lin.id] },
    });
    expect(outside.status).toBe(403);
    const inside = await as(mei).post(`/api/tables/tables/${deals.id}/records`, {
      values: { [title]: 'For me', [owner.id]: [mei.id] },
    });
    expect(inside.status).toBe(201);
    // The recycle bin is not hers.
    expect((await as(mei).get(`/api/tables/bases/${deals.base_id}/trash`)).status).toBe(403);
  });

  it('read-only tables refuse writes; one of the four roles beats a custom role', async () => {
    const { app, lin, mei, as, base, deals, title, role } = await sales();
    await as(lin).patch(`/api/tables/roles/${role.id}`, {
      revision: role.revision,
      rules: { tables: { [deals.id]: { access: 'read' } } },
    });
    const refused = await as(mei).post(`/api/tables/tables/${deals.id}/records`, { values: { [title]: 'x' } });
    expect(refused.status).toBe(403);
    expect((await as(mei).get(`/api/tables/bases/${base.id}`)).body).toMatchObject({ access: 'viewer' });
    // As an editor through a group as well, she sees and edits everything.
    const group = newId('group');
    await getDb().insert(groups).values({ id: group, name: 'Team', createdBy: lin.id });
    await getDb().insert(groupMembers).values({ groupId: group, memberId: mei.id });
    await as(lin).put(`/api/tables/bases/${base.id}/share`, {
      items: [
        { type: 'member', id: mei.id, role: 'custom', custom_role_id: role.id },
        { type: 'group', id: group, role: 'editor' },
      ],
    });
    app.services.tables.forgetAudiences();
    const detail = (await as(mei).get(`/api/tables/bases/${base.id}`)).body;
    expect(detail).toMatchObject({ access: 'editor', custom_role: null });
    expect(detail.tables).toHaveLength(2);
    const page = await as(mei).post(`/api/tables/tables/${deals.id}/records/query`, { count: true });
    expect(page.body.total).toBe(2);
  });

  it('tell a role that records changed, not which; and no one about comments on records they do not see', async () => {
    const { app, lin, mei, as, deals, title, mine, hers } = await sales();
    const events: RealtimeEvent[] = [];
    app.services.hub.subscribe(mei.id, (event) => events.push(event));
    await as(lin).patch(`/api/tables/records/${mine.id}`, {
      revision: mine.revision,
      values: { [title]: 'Lin deal 2' },
    });
    expect(events).toContainEqual({
      type: 'records.changed',
      data: { base_id: deals.base_id, table_id: deals.id, records: [] },
    });
    // A mention on a record she does not see does not reach her, nor do its comment events.
    await as(lin).post(`/api/tables/records/${mine.id}/comments`, {
      body: `[@Mei](member:${mei.id}) see the walrus deal`,
    });
    expect(events.some((event) => event.type === 'comments.updated')).toBe(false);
    const told = async () =>
      (await getDb().select().from(notifications).where(eq(notifications.memberId, mei.id))).filter(
        (row) => row.kind !== 'share',
      );
    expect(await told()).toEqual([]);
    // On her own record she is told.
    await as(lin).post(`/api/tables/records/${hers.id}/comments`, { body: `[@Mei](member:${mei.id}) nice` });
    expect(await told()).toHaveLength(1);
  });

  it('keep the history of hidden fields and the files in them from a role', async () => {
    const { app, lin, mei, as, deals, title, hers } = await sales();
    const files = await as(lin).post(`/api/tables/tables/${deals.id}/fields`, { name: 'Contract', type: 'attachment' });
    const role = (await as(lin).get(`/api/tables/bases/${deals.base_id}/roles`)).body.items[0];
    await as(lin).patch(`/api/tables/roles/${role.id}`, {
      revision: role.revision,
      rules: {
        tables: {
          [deals.id]: {
            ...role.rules.tables[deals.id],
            hidden_fields: [...role.rules.tables[deals.id].hidden_fields, files.body.id],
          },
        },
      },
    });
    const form = new FormData();
    form.set('file', new Blob(['secret terms'], { type: 'text/plain' }), 'terms.txt');
    const uploaded = await app.app.request(`/api/tables/bases/${deals.base_id}/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lin.token}` },
      body: form,
    });
    const file = (await uploaded.json()) as { id: string };
    const now = (await as(lin).get(`/api/tables/records/${hers.id}`)).body.record;
    await as(lin).patch(`/api/tables/records/${hers.id}`, {
      revision: now.revision,
      values: { [files.body.id]: [file.id] },
    });
    // The file in a hidden field does not open for her; it does for Lin.
    expect((await as(mei).get(`/api/files/${file.id}`)).status).toBe(404);
    expect((await as(lin).get(`/api/files/${file.id}`)).status).toBe(200);
    // Her record's history leaves out the change she cannot see.
    const activity = (await as(mei).get(`/api/tables/records/${hers.id}/activity`)).body.items;
    const changed = activity.flatMap((item: any) => (item.kind === 'event' ? item.changes : []));
    expect(changed.map((change: any) => change.field)).not.toContain(files.body.id);
    expect(activity.filter((item: any) => item.kind === 'event').map((item: any) => item.type)).toEqual(['created']);
    void title;
  });
});
