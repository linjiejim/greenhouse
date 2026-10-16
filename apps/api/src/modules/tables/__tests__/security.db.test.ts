/**
 * The findings of the phase 1 security review (H1, M1–M3, L1–L14), each held by a test where
 * one makes sense.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { RealtimeEvent } from '@greenhouse/contract';
import { auditEvents, baseRecordEvents, baseRecords, files, getDb, groups, jobs, members, newId } from '@greenhouse/db';
import { streamedUpload } from '../../files/__tests__/streamed-upload.js';
import { createTestApp } from '../../../testing.js';
import { titlesOf } from '../load.js';
import { purgeRecords } from '../purge.js';

type App = ReturnType<typeof createTestApp>;
type Who = Awaited<ReturnType<App['member']>>;

async function setup() {
  const app = createTestApp({ STORAGE_PROVIDER: 'local', STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'gh-sec-')) });
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
  const base = async (who: Who, name: string) => {
    const made = (await as(who).post('/api/tables/bases', { name })).body;
    return { base: made, table: made.tables[0], primary: made.tables[0].fields[0].id as string };
  };
  const field = async (who: Who, tableId: string, body: object) => {
    const made = await as(who).post(`/api/tables/tables/${tableId}/fields`, body);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return made.body;
  };
  const record = async (who: Who, tableId: string, values: object) => {
    const made = await as(who).post(`/api/tables/tables/${tableId}/records`, { values });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return made.body.record;
  };
  const share = (owner: Who, baseId: string, items: object[]) =>
    as(owner).put(`/api/tables/bases/${baseId}/share`, { items });
  return { app, lin, mei, person, as, base, field, record, share };
}

describe('security review', () => {
  it('H1: a record’s history names titles only of linked records of its own base', async () => {
    const { lin, mei, as, base, field, record } = await setup();
    const secret = await base(lin, 'Private');
    const plan = await record(lin, secret.table.id, { [secret.primary]: 'Acquisition plan' });
    const mine = await base(mei, 'Mine');
    // An option id that looks like Lin's record id.
    const tags = await field(mei, mine.table.id, {
      name: 'Tags',
      type: 'multi_select',
      config: { options: [{ id: plan.id, label: 'odd', color: 'gray' }] },
    });
    const other = await record(mei, mine.table.id, { [mine.primary]: 'Other' });
    const links = await field(mei, mine.table.id, {
      name: 'See also',
      type: 'relation',
      config: { table_id: mine.table.id },
    });
    const row = await record(mei, mine.table.id, {
      [mine.primary]: 'Row',
      [tags.id]: [plan.id],
      [links.id]: [other.id],
    });
    const activity = await as(mei).get(`/api/tables/records/${row.id}/activity`);
    expect(activity.status).toBe(200);
    expect(activity.body.linked[plan.id]).toBeUndefined();
    expect(activity.body.linked[other.id]).toEqual({ title: 'Other', table_id: mine.table.id });
    // Asked directly for another base's record, titlesOf names nothing.
    expect(await titlesOf(mine.base.id, [plan.id, other.id])).toEqual({
      [other.id]: { title: 'Other', table_id: mine.table.id },
    });
  });

  it('M1: a CSV export keeps text that a spreadsheet would run as text, and numbers as they are', async () => {
    const { app, lin, base, field, record } = await setup();
    const { table, primary } = await base(lin, 'Csv');
    const amount = await field(lin, table.id, { name: 'Amount', type: 'number' });
    const tag = await field(lin, table.id, {
      name: '=Tag',
      type: 'single_select',
      config: { options: [{ id: 'x', label: '@risky', color: 'gray' }] },
    });
    await record(lin, table.id, { [primary]: '=HYPERLINK("http://evil","x")', [amount.id]: -5, [tag.id]: 'x' });
    const response = await app.app.request(`/api/tables/tables/${table.id}/export`, {
      headers: { authorization: `Bearer ${lin.token}` },
    });
    const lines = (await response.text()).replace(/^\uFEFF/, '').split('\r\n');
    expect(lines[0]).toBe("名称,Amount,'=Tag");
    expect(lines[1]).toBe('"\'=HYPERLINK(""http://evil"",""x"")",-5,\'@risky');
  });

  it('M2: an upload is refused before its body is read for someone who may not upload, and capped as it streams', async () => {
    const { app, lin, mei, base, share } = await setup();
    const { base: made } = await base(lin, 'Files');
    await share(lin, made.id, [{ type: 'member', id: mei.id, role: 'viewer' }]);
    const send = (who: Who, size: number) => {
      const { body, type } = streamedUpload(size);
      return app.app.request(`/api/tables/bases/${made.id}/files`, {
        method: 'POST',
        headers: { authorization: `Bearer ${who.token}`, 'content-type': type },
        body,
        duplex: 'half',
      } as RequestInit);
    };
    expect((await send(mei, 51 * 1024 * 1024)).status).toBe(403);
    expect((await send(lin, 1024)).status).toBe(201);
    const huge = await send(lin, 51 * 1024 * 1024);
    expect(huge.status).toBe(413);
  });

  it('M3: the recycle bin pages through records deleted together without skipping any', async () => {
    const { lin, as, base } = await setup();
    const { base: made, table, primary } = await base(lin, 'Bin');
    const pasted = await as(lin).post(`/api/tables/tables/${table.id}/records/bulk`, {
      items: Array.from({ length: 60 }, (_, index) => ({ values: { [primary]: `r${index}` } })),
    });
    const ids = pasted.body.items.map((item: any) => item.record.id);
    expect((await as(lin).post(`/api/tables/tables/${table.id}/records/delete`, { ids })).body).toEqual({
      deleted: 60,
    });
    const first = await as(lin).get(`/api/tables/bases/${made.id}/trash?limit=50`);
    expect(first.body.items).toHaveLength(50);
    const second = await as(lin).get(
      `/api/tables/bases/${made.id}/trash?limit=50&cursor=${encodeURIComponent(first.body.next_cursor)}`,
    );
    const seen = [...first.body.items, ...second.body.items].map((item: any) => item.id);
    expect(new Set(seen).size).toBe(60);
    expect(second.body.next_cursor).toBeNull();
    const bad = Buffer.from(JSON.stringify({ at: 'not a time', id: 'x' })).toString('base64url');
    expect((await as(lin).get(`/api/tables/bases/${made.id}/trash?cursor=${bad}`)).status).toBe(400);
    expect((await as(lin).get(`/api/tables/records/${ids[0]}/activity?cursor=${bad}`)).status).toBe(400);
  });

  it('L1: a type change keeps only values that fit the new type', async () => {
    const { lin, as, base, field, record } = await setup();
    const { table, primary } = await base(lin, 'Types');
    const site = await field(lin, table.id, { name: 'Site', type: 'text' });
    const bad = await record(lin, table.id, { [primary]: 'a', [site.id]: 'javascript:alert(1)' });
    await record(lin, table.id, { [primary]: 'b', [site.id]: 'https://example.com' });
    const schema = async () =>
      (await as(lin).get(`/api/tables/bases/${table.base_id}`)).body.tables[0].schema_revision as number;
    const refused = await as(lin).patch(`/api/tables/fields/${site.id}`, {
      schema_revision: await schema(),
      type: 'url',
    });
    expect(refused).toMatchObject({
      status: 409,
      body: { error: { code: 'type_change_values', details: { count: 1, record_ids: [bad.id] } } },
    });
    await as(lin).patch(`/api/tables/records/${bad.id}`, { revision: bad.revision, values: { [site.id]: null } });
    const changed = await as(lin).patch(`/api/tables/fields/${site.id}`, {
      schema_revision: await schema(),
      type: 'url',
    });
    expect(changed.body.type).toBe('url');
  });

  it('L2: deleting for good is audited, and records that linked to it hear of it', async () => {
    const { lin, as, base, field, record } = await setup();
    const { base: made, table, primary } = await base(lin, 'Purge');
    const links = await field(lin, table.id, { name: 'Links', type: 'relation', config: { table_id: table.id } });
    const target = await record(lin, table.id, { [primary]: 'Target' });
    const source = await record(lin, table.id, { [primary]: 'Source', [links.id]: [target.id] });
    await as(lin).del(`/api/tables/records/${target.id}`);
    expect((await as(lin).post(`/api/tables/records/${target.id}/purge`)).status).toBe(204);
    const audit = await getDb()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'base_record.purge'), eq(auditEvents.resourceId, made.id)));
    expect(audit).toHaveLength(1);
    const [row] = await getDb().select().from(baseRecords).where(eq(baseRecords.id, source.id));
    expect(row!.revision).toBe(source.revision + 1);
    const events = await getDb().select().from(baseRecordEvents).where(eq(baseRecordEvents.recordId, source.id));
    expect(events.at(-1)).toMatchObject({
      type: 'updated',
      changes: [{ field: links.id, before: [target.id], after: null }],
      meta: { purged: true },
    });
    // A record not in the bin is never deleted for good this way.
    expect(await purgeRecords([source.id], { memberId: lin.id, baseId: made.id })).toEqual({ count: 0, touched: [] });
  });

  it('L5: long id lists go as one parameter', async () => {
    const { lin, base } = await setup();
    const { base: made } = await base(lin, 'Many');
    const ids = Array.from({ length: 70_000 }, (_, index) => `rec_${String(index).padStart(26, '0')}`);
    expect(await titlesOf(made.id, ids)).toEqual({});
    expect(await purgeRecords(ids, { memberId: lin.id, baseId: made.id })).toEqual({ count: 0, touched: [] });
  });

  it('L7 and L8: a deleted record is the bin’s, and not found is the same for everyone else', async () => {
    const { lin, mei, as, base, record, share, person } = await setup();
    const { base: made, table, primary } = await base(lin, 'Bin rights');
    const gone = await record(lin, table.id, { [primary]: 'Gone' });
    const live = await record(lin, table.id, { [primary]: 'Live' });
    await as(lin).del(`/api/tables/records/${gone.id}`);
    await share(lin, made.id, [{ type: 'member', id: mei.id, role: 'viewer' }]);
    // A viewer reads neither the history nor the comments of a deleted record.
    expect((await as(mei).get(`/api/tables/records/${gone.id}/activity`)).status).toBe(404);
    expect((await as(lin).get(`/api/tables/records/${gone.id}/activity`)).status).toBe(200);
    // Someone outside the base learns nothing: deleted, live or made up, it is the same answer.
    const kai = await person('Kai');
    const answers = await Promise.all(
      [gone.id, live.id, 'rec_00000000000000000000000000'].map((id) =>
        as(kai).post(`/api/tables/records/${id}/restore`),
      ),
    );
    expect(answers.map((answer) => [answer.status, answer.body.error.message])).toEqual([
      [404, 'Record not found.'],
      [404, 'Record not found.'],
      [404, 'Record not found.'],
    ]);
    // A viewer of the base gets the same for the bin's actions.
    expect((await as(mei).post(`/api/tables/records/${gone.id}/restore`)).status).toBe(404);
    expect((await as(mei).post(`/api/tables/records/${gone.id}/purge`)).status).toBe(404);
  });

  it('L9: who hears about a base follows group changes at once', async () => {
    const { app, lin, mei, base, record, share } = await setup();
    const { base: made, table, primary } = await base(lin, 'Teams');
    const groupId = newId('group');
    await getDb().insert(groups).values({ id: groupId, name: 'Team', createdBy: lin.id });
    await share(lin, made.id, [{ type: 'group', id: groupId, role: 'viewer' }]);
    const events: RealtimeEvent[] = [];
    app.services.hub.subscribe(mei.id, (event) => events.push(event));
    const before = await record(lin, table.id, { [primary]: 'Before' });
    // Mei joins the group (through the members service, which tells tables), within the seconds
    // the audience of the base is kept.
    await app.services.members.saveGroup(lin.id, { name: 'Team', member_ids: [mei.id] }, groupId);
    const after = await record(lin, table.id, { [primary]: 'After' });
    // Realtime events go out once the audience is known, after the answer.
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    const told = events.flatMap((event) =>
      event.type === 'records.changed' ? event.data.records.map((entry) => entry.id) : [],
    );
    expect(told).toEqual([after.id]);
    expect(told).not.toContain(before.id);
  });

  it('L11: attachments of deleted records do not open; their bytes go after the commit; unattached uploads are swept', async () => {
    const { app, lin, as, base, field, record } = await setup();
    const { base: made, table, primary } = await base(lin, 'Attach');
    const attachment = await field(lin, table.id, { name: 'File', type: 'attachment' });
    const upload = async () => {
      const form = new FormData();
      form.set('file', new Blob(['bytes'], { type: 'text/plain' }), 'a.txt');
      const response = await app.app.request(`/api/tables/bases/${made.id}/files`, {
        method: 'POST',
        headers: { authorization: `Bearer ${lin.token}` },
        body: form,
      });
      return ((await response.json()) as { id: string }).id;
    };
    // An upload no record took, a day old: the daily purge sweeps it.
    const stray = await upload();
    await getDb()
      .update(files)
      .set({ createdAt: sql`now() - interval '2 days'` })
      .where(eq(files.id, stray));
    const held = await upload();
    const row = await record(lin, table.id, { [primary]: 'With file', [attachment.id]: [held] });
    expect((await as(lin).get(`/api/files/${held}`)).status).toBe(200);
    await as(lin).del(`/api/tables/records/${row.id}`);
    expect((await as(lin).get(`/api/files/${held}`)).status).toBe(404);
    // The same file cannot sit in two records.
    await as(lin).post(`/api/tables/records/${row.id}/restore`);
    const twice = await as(lin).post(`/api/tables/tables/${table.id}/records`, {
      values: { [primary]: 'Copy', [attachment.id]: [held] },
    });
    expect(twice.status).toBe(400);
    // Deleted for good: the bytes wait for the commit, in a job.
    await as(lin).del(`/api/tables/records/${row.id}`);
    await as(lin).post(`/api/tables/records/${row.id}/purge`);
    const [queued] = await getDb().select().from(jobs).where(eq(jobs.kind, 'base_discard'));
    expect(queued?.payload).toEqual({ file_ids: [held] });
    await app.services.tables.worker.drain();
    const [file] = await getDb().select().from(files).where(eq(files.id, held));
    expect(file!.status).toBe('deleted');
    const [swept] = await getDb().select().from(files).where(eq(files.id, stray));
    expect(swept!.status).toBe('deleted');
  });

  it('L12: bases come in pages, views have a cap, and JSON bodies a size', async () => {
    const { app, lin, as, base } = await setup();
    for (const name of ['A', 'B', 'C']) await base(lin, name);
    const first = await as(lin).get('/api/tables/bases?limit=2');
    expect(first.body.items.map((item: any) => item.name)).toEqual(['A', 'B']);
    const rest = await as(lin).get(`/api/tables/bases?limit=2&cursor=${first.body.next_cursor}`);
    expect(rest.body.items.map((item: any) => item.name)).toEqual(['C']);
    expect(rest.body.next_cursor).toBeNull();
    const all = await app.services.tables.list(lin.id, { archived: false, limit: 500 });
    expect(all.items).toHaveLength(3);

    const { table } = await base(lin, 'Views cap');
    for (let index = 1; index < 100; index++) {
      const made = await as(lin).post(`/api/tables/tables/${table.id}/views`, {
        name: `V${index}`,
        type: 'grid',
        personal: true,
      });
      expect(made.status).toBe(201);
    }
    const over = await as(lin).post(`/api/tables/tables/${table.id}/views`, {
      name: 'One more',
      type: 'grid',
      personal: true,
    });
    expect(over).toMatchObject({ status: 409, body: { error: { code: 'too_many_views' } } });

    const big = await app.app.request(`/api/tables/tables/${table.id}/records/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lin.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ search: 'x'.repeat(9 * 1024 * 1024) }),
    });
    expect(big.status).toBe(413);
  });

  it('L13: a paste answers each failed item on its own, and name clashes are 409', async () => {
    const { lin, as, base, field } = await setup();
    const { table, primary } = await base(lin, 'Clashes');
    const count = await field(lin, table.id, { name: 'Count', type: 'number' });
    const pasted = await as(lin).post(`/api/tables/tables/${table.id}/records/bulk`, {
      items: [
        { values: { [primary]: 'ok' } },
        { values: { [count.id]: 'not a number' } },
        { id: 'rec_missing', values: {} },
      ],
    });
    expect(pasted.body.items.map((item: any) => (item.ok ? 'ok' : item.code))).toEqual([
      'ok',
      'invalid_input',
      'not_found',
    ]);
    // A deleted field whose name was taken meanwhile does not come back over it.
    await as(lin).del(`/api/tables/fields/${count.id}`);
    await field(lin, table.id, { name: 'Count', type: 'text' });
    expect((await as(lin).post(`/api/tables/fields/${count.id}/restore`)).body.error.code).toBe('name_taken');
  });

  it('L14: record ids are random; records keep the order they were made in', async () => {
    const { lin, as, base } = await setup();
    const { table, primary } = await base(lin, 'Order');
    const pasted = await as(lin).post(`/api/tables/tables/${table.id}/records/bulk`, {
      items: Array.from({ length: 30 }, (_, index) => ({ values: { [primary]: `r${index}` } })),
    });
    const ids: string[] = pasted.body.items.map((item: any) => item.record.id);
    const listed = await as(lin).post(`/api/tables/tables/${table.id}/records/query`, {});
    expect(listed.body.items.map((item: any) => item.values[primary])).toEqual(
      Array.from({ length: 30 }, (_, index) => `r${index}`),
    );
    // Ids made in the same millisecond do not follow one another.
    const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const random = (id: string) =>
      [...id.slice(-16)].reduce((total, char) => total * 32n + BigInt(ALPHABET.indexOf(char)), 0n);
    for (let index = 1; index < ids.length; index++) {
      const [a, b] = [ids[index - 1]!, ids[index]!];
      if (a.slice(4, 14) === b.slice(4, 14)) expect(random(b) - random(a)).not.toBe(1n);
    }
  });
});
