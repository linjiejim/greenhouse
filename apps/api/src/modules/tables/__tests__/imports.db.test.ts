import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, type RealtimeEvent } from '@greenhouse/contract';
import { baseImports, baseRecordEvents, baseTables, files, getDb, jobs, members } from '@greenhouse/db';
import { createTestApp } from '../../../testing.js';
import { createImports } from '../imports.js';
import { createTablesWorker } from '../worker.js';

type App = ReturnType<typeof createTestApp>;
type Who = Awaited<ReturnType<App['member']>>;

async function setup() {
  const app = createTestApp({ STORAGE_PROVIDER: 'local', STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'gh-imports-')) });
  const person = async (name: string, email: string) => {
    const who = await app.member('member', email);
    await getDb().update(members).set({ name, timezone: 'Asia/Shanghai' }).where(eq(members.id, who.id));
    return { ...who, name };
  };
  const lin = await person('Lin', 'lin@example.com');
  const mei = await person('Mei', 'mei@example.com');
  const as = (who: Who) => ({
    get: (path: string) => app.call('GET', path, { token: who.token }),
    post: (path: string, body: unknown = {}) => app.call('POST', path, { token: who.token, body }),
    patch: (path: string, body: unknown) => app.call('PATCH', path, { token: who.token, body }),
    put: (path: string, body: unknown) => app.call('PUT', path, { token: who.token, body }),
    del: (path: string) => app.call('DELETE', path, { token: who.token }),
  });
  /** A CSV file sent the way the web app sends it. */
  async function upload(who: Who, tableId: string, content: BlobPart, name = 'data.csv') {
    const form = new FormData();
    form.set('file', new File([content], name, { type: 'text/csv' }));
    const response = await app.app.request(`/api/tables/tables/${tableId}/imports`, {
      method: 'POST',
      headers: { authorization: `Bearer ${who.token}` },
      body: form,
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as any) : null };
  }
  /** Realtime events a member's open sockets would get. */
  function listen(who: Who) {
    const events: RealtimeEvent[] = [];
    app.services.hub.subscribe(who.id, (event) => events.push(event));
    return events;
  }
  return { app, lin, mei, person, as, upload, listen, drain: () => app.services.tables.worker.drain() };
}

type Setup = Awaited<ReturnType<typeof setup>>;
type As = ReturnType<Setup['as']>;

/** A blank base: 名称, Count (a number, required when asked), Due, Status, Owner and an attachment field. */
async function blank(as: As, options: { required?: boolean } = {}) {
  const base = (await as.post('/api/tables/bases', { name: 'Fruit' })).body;
  const table = base.tables[0];
  const field = async (body: object) => {
    const made = await as.post(`/api/tables/tables/${table.id}/fields`, body);
    expect(made.status).toBe(201);
    return made.body;
  };
  const count = await field({ name: 'Count', type: 'number', required: options.required ?? false });
  const due = await field({ name: 'Due', type: 'date' });
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
  const owner = await field({ name: 'Owner', type: 'member' });
  const attachments = await field({ name: 'Files', type: 'attachment' });
  return { base, table, primary: table.fields[0], count, due, status, owner, attachments };
}

async function recordsOf(as: As, tableId: string) {
  const page = await as.post(`/api/tables/tables/${tableId}/records/query`, { limit: 500 });
  expect(page.status).toBe(200);
  return page.body.items as Array<{ id: string; values: Record<string, unknown> }>;
}

async function schemaOf(tableId: string) {
  const [row] = await getDb().select().from(baseTables).where(eq(baseTables.id, tableId));
  return row!.schemaRevision;
}

/** Rows `Item 1`…`Item n` with their number. */
const numbered = (n: number) =>
  ['名称,Count', ...Array.from({ length: n }, (_, index) => `Item ${index + 1},${index + 1}`)].join('\n');

/** Jobs waiting out a backoff are ready now (time stands still inside a test's transaction). */
const ready = () =>
  getDb()
    .update(jobs)
    .set({ availableAt: sql`now()` })
    .where(eq(jobs.kind, 'base_import'));

const setImport = (id: string, values: PgUpdateSetSource<typeof baseImports>) =>
  getDb().update(baseImports).set(values).where(eq(baseImports.id, id));

/** A second imports part on its own worker, whose jobs hand the rest on after every batch. */
function slicing(app: App) {
  const worker = createTablesWorker();
  const { files: filesService, notifications, hub, providers } = app.services;
  createImports(
    {
      files: filesService,
      notifications,
      hub,
      providers,
      records: app.services.tables.records,
      worker,
      audience: async () => [],
      baseChanged: async () => undefined,
      touch: async () => undefined,
    },
    { sliceMs: 0 },
  );
  return worker;
}

describe('uploading a CSV file', () => {
  it('reads the file and suggests a field for each column by name', async () => {
    const { lin, as, upload } = await setup();
    const { table, primary, count, due } = await blank(as(lin));
    const csv =
      '\uFEFF名称, count ,Due,Files,Notes\r\n"Apple, red",3,2026-10-20,a.png,"say ""hi"""\r\n\r\nPear,,,,\r\n';
    const made = await upload(lin, table.id, csv, 'fruit.csv');
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      table_id: table.id,
      file_name: 'fruit.csv',
      status: 'draft',
      header: true,
      columns: [
        { index: 0, first: '名称', samples: ['Apple, red', 'Pear'] },
        { index: 1, first: 'count', samples: ['3'] },
        { index: 2, first: 'Due', samples: ['2026-10-20'] },
        { index: 3, first: 'Files', samples: ['a.png'] },
        { index: 4, first: 'Notes', samples: ['say "hi"'] },
      ],
      // Attachments are never imported into; no field is called Notes.
      mapping: [primary.id, count.id, due.id, null, null],
      total_rows: 2,
      committed_rows: 0,
      result: { created: 0, skipped: 0, errors: [], more_errors: 0 },
      failure: null,
    });
    const hours = (Date.parse(made.body.expires_at) - Date.parse(made.body.created_at)) / 3_600_000;
    expect(hours).toBeCloseTo(24, 5);
    const [row] = await getDb().select().from(baseImports).where(eq(baseImports.id, made.body.id));
    const [file] = await getDb().select().from(files).where(eq(files.id, row!.fileId!));
    expect(file).toMatchObject({ purpose: 'import', ownerId: lin.id, status: 'active' });

    expect((await as(lin).get(`/api/tables/imports/${made.body.id}`)).body).toEqual(made.body);
    const listed = await as(lin).get(`/api/tables/tables/${table.id}/imports?limit=1`);
    expect(listed.body).toEqual({ items: [made.body], next_cursor: null });
  });

  it('refuses files it cannot read, saying why', async () => {
    const { lin, as, upload } = await setup();
    const { table } = await blank(as(lin));
    // 「名称」 in GBK, as Excel saves a plain CSV on a Chinese Windows.
    const gbk = new Uint8Array([0xc3, 0xfb, 0xb3, 0xc6, 0x0a, 0x31, 0x0a]);
    expect(await upload(lin, table.id, gbk)).toMatchObject({ status: 400, body: { error: { code: 'not_utf8' } } });
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
    expect(await upload(lin, table.id, zip, 'book.xlsx')).toMatchObject({
      status: 400,
      body: { error: { code: 'not_csv' } },
    });
    expect(await upload(lin, table.id, '名称\nok\n"never closed\n')).toMatchObject({
      status: 400,
      body: { error: { code: 'unclosed_quote', details: { row: 3 } } },
    });
    expect(await upload(lin, table.id, '\n,\n')).toMatchObject({
      status: 400,
      body: { error: { code: 'empty_file' } },
    });
    expect(await upload(lin, table.id, numbered(MAX_IMPORT_ROWS + 1))).toMatchObject({
      status: 400,
      body: { error: { code: 'too_many_rows' } },
    });
    expect(await upload(lin, table.id, 'x'.repeat(MAX_IMPORT_BYTES + 1))).toMatchObject({
      status: 413,
      body: { error: { code: 'too_large' } },
    });
    // Nothing was kept of them.
    expect(await getDb().select().from(baseImports)).toEqual([]);
  });

  it('lets only editors of the base import, and an import is only its importer’s', async () => {
    const { lin, mei, person, as, upload } = await setup();
    const kai = await person('Kai', 'kai@example.com');
    const { base, table } = await blank(as(lin));
    // Not shared: the table is not there for them.
    expect((await upload(mei, table.id, numbered(2))).status).toBe(404);
    await as(lin).put(`/api/tables/bases/${base.id}/share`, {
      items: [
        { type: 'member', id: mei.id, role: 'viewer' },
        { type: 'member', id: kai.id, role: 'editor' },
      ],
    });
    expect(await upload(mei, table.id, numbered(2))).toMatchObject({
      status: 403,
      body: { error: { code: 'forbidden' } },
    });
    const kais = await upload(kai, table.id, numbered(2));
    expect(kais.status).toBe(201);
    // Not even the base's owner sees someone else's import.
    expect((await as(lin).get(`/api/tables/imports/${kais.body.id}`)).status).toBe(404);
    expect((await as(lin).post(`/api/tables/imports/${kais.body.id}/start`)).status).toBe(404);
    expect((await as(lin).get(`/api/tables/tables/${table.id}/imports`)).body.items).toEqual([]);
  });
});

describe('the mapping of a draft', () => {
  it('changes while it is a draft, into fields that can take a column, each field once', async () => {
    const { lin, as, upload } = await setup();
    const { table, primary, count, attachments } = await blank(as(lin));
    const made = (await upload(lin, table.id, 'Fruit,Amount\nApple,3\nPear,4\n')).body;
    expect(made.mapping).toEqual([null, null]);
    const path = `/api/tables/imports/${made.id}`;
    const status = async (mapping: unknown[]) => (await as(lin).patch(path, { mapping })).status;
    expect(await status([primary.id])).toBe(400);
    expect(await status([primary.id, attachments.id])).toBe(400);
    expect(await status([primary.id, primary.id])).toBe(400);
    expect(await status([primary.id, 'fld_missing'])).toBe(400);

    const mapped = await as(lin).patch(path, { mapping: [primary.id, count.id], header: false });
    expect(mapped.body).toMatchObject({ mapping: [primary.id, count.id], header: false, total_rows: 3 });
    const back = await as(lin).patch(path, { header: true });
    expect(back.body).toMatchObject({ mapping: [primary.id, count.id], header: true, total_rows: 2 });

    expect((await as(lin).post(`${path}/start`)).body.status).toBe('queued');
    expect((await as(lin).patch(path, { header: false })).body.error.code).toBe('import_started');
    expect((await as(lin).post(`${path}/start`)).body.error.code).toBe('import_started');
  });

  it('starts with a column mapped, every required field mapped and every mapped field still there', async () => {
    const { lin, as, upload } = await setup();
    const { table, primary, count, due } = await blank(as(lin), { required: true });
    const made = (await upload(lin, table.id, 'Fruit,Due\nApple,2026-10-20\n')).body;
    const path = `/api/tables/imports/${made.id}`;
    await as(lin).patch(path, { mapping: [null, null] });
    expect((await as(lin).post(`${path}/start`)).body.error.code).toBe('nothing_mapped');
    await as(lin).patch(path, { mapping: [primary.id, due.id] });
    expect((await as(lin).post(`${path}/start`)).body.error).toMatchObject({
      code: 'required_unmapped',
      details: { fields: ['Count'] },
    });
    await as(lin).patch(`/api/tables/fields/${count.id}`, {
      schema_revision: await schemaOf(table.id),
      required: false,
    });
    expect((await as(lin).del(`/api/tables/fields/${due.id}`)).status).toBe(204);
    expect((await as(lin).post(`${path}/start`)).body.error.code).toBe('fields_changed');
    // A draft past its day does not start.
    await as(lin).patch(path, { mapping: [primary.id, null] });
    await setImport(made.id, { expiresAt: sql`now() - interval '1 minute'` });
    expect((await as(lin).post(`${path}/start`)).body.error.code).toBe('import_expired');
  });
});

describe('running an import', () => {
  it('creates the rows it can read and reports those it skips, as the importer', async () => {
    const { lin, mei, as, upload, listen, drain } = await setup();
    const { table, primary, count, due, status, owner } = await blank(as(lin), { required: true });
    const events = listen(lin);
    const csv = [
      '名称,Count,Due,Status,Owner',
      'Apple,3,2026-10-20,To do,mei@example.com',
      'Pear,abc,2026-10-21,Doing,Mei',
      'Plum,5,2026-13-40,Done,',
      'Fig,6,2026-10-22,Maybe,',
      'Kiwi,7,,Done,Nobody',
      ',8,2026-10-23,To do,',
      'Lime,"1,200",2026/10/24,doing,Lin',
      'Mango,,2026-10-25,To do,',
    ].join('\r\n');
    const made = (await upload(lin, table.id, csv)).body;
    const started = await as(lin).post(`/api/tables/imports/${made.id}/start`);
    expect(started.body).toMatchObject({ status: 'queued', expires_at: null, total_rows: 8 });
    const [job] = await getDb().select().from(jobs).where(eq(jobs.kind, 'base_import'));
    expect(job).toMatchObject({ dedupeKey: `base_import:${made.id}:0`, payload: { import_id: made.id } });

    await drain();
    expect((await as(lin).get(`/api/tables/imports/${made.id}`)).body).toMatchObject({
      status: 'done',
      total_rows: 8,
      committed_rows: 8,
      failure: null,
      result: {
        created: 3,
        skipped: 5,
        more_errors: 0,
        errors: [
          { row: 3, column: 1, reason: 'number', text: 'abc' },
          { row: 4, column: 2, reason: 'date', text: '2026-13-40' },
          { row: 5, column: 3, reason: 'option', text: 'Maybe' },
          { row: 6, column: 4, reason: 'member', text: 'Nobody' },
          { row: 9, column: 1, reason: 'required', text: '' },
        ],
      },
    });
    const rows = await recordsOf(as(lin), table.id);
    expect(rows.map((row) => row.values[primary.id] ?? '')).toEqual(['Apple', '', 'Lime']);
    expect(rows[0]!.values).toMatchObject({
      [count.id]: 3,
      [due.id]: '2026-10-20',
      [status.id]: 'todo',
      [owner.id]: [mei.id],
    });
    expect(rows[2]!.values).toMatchObject({
      [count.id]: 1200,
      [due.id]: '2026-10-24',
      [status.id]: 'doing',
      [owner.id]: [lin.id],
    });
    // The history names the import, and the people of the base were told.
    const [history] = await getDb().select().from(baseRecordEvents).where(eq(baseRecordEvents.recordId, rows[0]!.id));
    expect(history).toMatchObject({
      actorType: 'import',
      actorId: lin.id,
      type: 'created',
      meta: { import_id: made.id },
    });
    expect(events.filter((event) => event.type === 'records.changed')).toHaveLength(1);
    // The file is not kept once the import is done.
    const [row] = await getDb().select().from(baseImports).where(eq(baseImports.id, made.id));
    const [file] = await getDb().select().from(files).where(eq(files.id, row!.fileId!));
    expect(file!.status).toBe('deleted');
  });

  it('imports the first row too when it is not the header', async () => {
    const { lin, as, upload, drain } = await setup();
    const { table, primary, count } = await blank(as(lin));
    const made = (await upload(lin, table.id, 'Apple,3\nPear,4\n')).body;
    await as(lin).patch(`/api/tables/imports/${made.id}`, { header: false, mapping: [primary.id, count.id] });
    await as(lin).post(`/api/tables/imports/${made.id}/start`);
    await drain();
    expect((await recordsOf(as(lin), table.id)).map((row) => row.values[count.id])).toEqual([3, 4]);
  });

  it('finds linked records by title, rows made earlier in the same file too', async () => {
    const { lin, as, upload, drain } = await setup();
    const base = (await as(lin).post('/api/tables/bases', { name: 'Plan' })).body;
    const tasks = base.tables[0];
    const projects = (await as(lin).post(`/api/tables/bases/${base.id}/tables`, { name: 'Projects' })).body;
    const title = projects.fields[0].id;
    const alpha = (await as(lin).post(`/api/tables/tables/${projects.id}/records`, { values: { [title]: 'Alpha' } }))
      .body.record;
    const beta = (await as(lin).post(`/api/tables/tables/${projects.id}/records`, { values: { [title]: 'Beta' } })).body
      .record;
    const project = (
      await as(lin).post(`/api/tables/tables/${tasks.id}/fields`, {
        name: 'Project',
        type: 'relation',
        config: { table_id: projects.id },
      })
    ).body;
    const parent = (await as(lin).post(`/api/tables/tables/${tasks.id}/fields`, { name: 'Parent', type: 'parent' }))
      .body;
    const csv = '名称,Project,Parent\nDesign,alpha,\nBuild,"Alpha, Beta",design\nShip,Gamma,\n';
    const made = (await upload(lin, tasks.id, csv)).body;
    expect(made.mapping).toEqual([tasks.fields[0].id, project.id, parent.id]);
    await as(lin).post(`/api/tables/imports/${made.id}/start`);
    await drain();
    expect((await as(lin).get(`/api/tables/imports/${made.id}`)).body.result).toMatchObject({
      created: 2,
      skipped: 1,
      errors: [{ row: 4, column: 1, reason: 'record', text: 'Gamma' }],
    });
    const [design, build] = await recordsOf(as(lin), tasks.id);
    expect(design!.values[project.id]).toEqual([alpha.id]);
    expect(build!.values[project.id]).toEqual([alpha.id, beta.id]);
    expect(build!.values[parent.id]).toEqual([design!.id]);
  });

  it('after a failure partway, tries again from the rows already written, writing none twice', async () => {
    const { app, lin, as, upload, drain } = await setup();
    const { table, primary } = await blank(as(lin));
    const made = (await upload(lin, table.id, numbered(250))).body;
    await as(lin).post(`/api/tables/imports/${made.id}/start`);
    const records = app.services.tables.records;
    const insertFrom = records.insertFrom;
    let calls = 0;
    records.insertFrom = async (...args) => {
      if (++calls === 150) throw new Error('the database went away');
      return insertFrom(...args);
    };
    await drain();
    // The first batch is in; the second was rolled back whole.
    expect((await as(lin).get(`/api/tables/imports/${made.id}`)).body).toMatchObject({
      status: 'queued',
      committed_rows: 100,
      result: { created: 100, skipped: 0 },
    });
    expect(await recordsOf(as(lin), table.id)).toHaveLength(100);
    const [waiting] = await getDb().select().from(jobs).where(eq(jobs.kind, 'base_import'));
    expect(waiting).toMatchObject({ status: 'pending', attempts: 1, lastError: 'the database went away' });

    records.insertFrom = insertFrom;
    await ready();
    await drain();
    expect((await as(lin).get(`/api/tables/imports/${made.id}`)).body).toMatchObject({
      status: 'done',
      committed_rows: 250,
      result: { created: 250, skipped: 0 },
    });
    const titles = (await recordsOf(as(lin), table.id)).map((row) => row.values[primary.id]);
    expect(titles).toHaveLength(250);
    expect(new Set(titles).size).toBe(250);
    expect(titles[249]).toBe('Item 250');
  });

  it('fails with its job when the queue gives up', async () => {
    const { app, lin, as, upload, drain } = await setup();
    const { table } = await blank(as(lin));
    const made = (await upload(lin, table.id, numbered(3))).body;
    await as(lin).post(`/api/tables/imports/${made.id}/start`);
    await getDb().update(jobs).set({ maxAttempts: 1 }).where(eq(jobs.kind, 'base_import'));
    const records = app.services.tables.records;
    const insertFrom = records.insertFrom;
    records.insertFrom = async () => {
      throw new Error('the database went away');
    };
    await drain();
    records.insertFrom = insertFrom;
    expect((await as(lin).get(`/api/tables/imports/${made.id}`)).body).toMatchObject({
      status: 'failed',
      failure: 'stopped',
      committed_rows: 0,
    });
    const [job] = await getDb().select().from(jobs).where(eq(jobs.kind, 'base_import'));
    expect(job!.status).toBe('dead');
  });

  it('hands a long import on to a new job after each slice', async () => {
    const { app, lin, as, upload } = await setup();
    const worker = slicing(app);
    const { table } = await blank(as(lin));
    const made = (await upload(lin, table.id, numbered(250))).body;
    await as(lin).post(`/api/tables/imports/${made.id}/start`);
    await worker.drain();
    const queued = await getDb()
      .select({ key: jobs.dedupeKey, status: jobs.status })
      .from(jobs)
      .where(eq(jobs.kind, 'base_import'))
      .orderBy(jobs.createdAt, jobs.id);
    expect(queued).toEqual([
      { key: `base_import:${made.id}:0`, status: 'succeeded' },
      { key: `base_import:${made.id}:100`, status: 'succeeded' },
      { key: `base_import:${made.id}:200`, status: 'succeeded' },
    ]);
    expect((await as(lin).get(`/api/tables/imports/${made.id}`)).body).toMatchObject({
      status: 'done',
      committed_rows: 250,
      result: { created: 250 },
    });
    expect(await recordsOf(as(lin), table.id)).toHaveLength(250);
  });

  it('stops at the next batch when cancelled, keeping the rows written', async () => {
    const { app, lin, as, upload } = await setup();
    const worker = slicing(app);
    const { table } = await blank(as(lin));
    const made = (await upload(lin, table.id, numbered(250))).body;
    await as(lin).post(`/api/tables/imports/${made.id}/start`);
    // One job: the first batch, then the rest handed on.
    await worker.runOnce();
    const cancelled = await as(lin).post(`/api/tables/imports/${made.id}/cancel`);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', committed_rows: 100 });
    await worker.drain();
    expect((await as(lin).get(`/api/tables/imports/${made.id}`)).body).toMatchObject({
      status: 'cancelled',
      committed_rows: 100,
      result: { created: 100 },
    });
    expect(await recordsOf(as(lin), table.id)).toHaveLength(100);
    expect((await as(lin).post(`/api/tables/imports/${made.id}/cancel`)).body.error.code).toBe('import_finished');

    // A draft is cancelled at once.
    const draft = (await upload(lin, table.id, numbered(2))).body;
    expect((await as(lin).post(`/api/tables/imports/${draft.id}/cancel`)).body.status).toBe('cancelled');
    expect((await as(lin).post(`/api/tables/imports/${draft.id}/start`)).body.error.code).toBe('import_started');
  });

  it('fails when the importer can no longer edit the table', async () => {
    const { lin, mei, as, upload, drain } = await setup();
    const { base, table } = await blank(as(lin));
    await as(lin).put(`/api/tables/bases/${base.id}/share`, {
      items: [{ type: 'member', id: mei.id, role: 'editor' }],
    });
    const made = (await upload(mei, table.id, numbered(3))).body;
    expect((await as(mei).post(`/api/tables/imports/${made.id}/start`)).body.status).toBe('queued');
    await as(lin).put(`/api/tables/bases/${base.id}/share`, {
      items: [{ type: 'member', id: mei.id, role: 'viewer' }],
    });
    await drain();
    expect((await as(mei).get(`/api/tables/imports/${made.id}`)).body).toMatchObject({
      status: 'failed',
      failure: 'no_access',
      committed_rows: 0,
    });
    expect(await recordsOf(as(lin), table.id)).toHaveLength(0);
  });
});

describe('cleaning up', () => {
  it('deletes old drafts and finished imports with their files, and fails imports whose job is gone', async () => {
    const { app, lin, as, upload } = await setup();
    const { table } = await blank(as(lin));
    const make = async () => (await upload(lin, table.id, numbered(2))).body.id as string;
    const fileOf = async (id: string) =>
      (await getDb().select({ fileId: baseImports.fileId }).from(baseImports).where(eq(baseImports.id, id)))[0]!
        .fileId!;
    const statusOf = async (id: string) =>
      (await getDb().select({ status: files.status }).from(files).where(eq(files.id, id)))[0]?.status;
    const expired = await make();
    await setImport(expired, { expiresAt: sql`now() - interval '1 hour'` });
    const old = await make();
    await setImport(old, { status: 'done', updatedAt: sql`now() - interval '31 days'` });
    const recent = await make();
    await setImport(recent, { status: 'done', updatedAt: sql`now() - interval '29 days'` });
    // Running, quiet for hours, and no job left to run it.
    const stuck = await make();
    await setImport(stuck, { status: 'running', updatedAt: sql`now() - interval '3 hours'` });
    // Quiet as long, but its job still waits in the queue.
    const waiting = await make();
    await as(lin).post(`/api/tables/imports/${waiting}/start`);
    await setImport(waiting, { updatedAt: sql`now() - interval '3 hours'` });
    const fresh = await make();
    const orphan = await app.services.files.store(lin.id, {
      name: 'left.csv',
      contentType: 'text/csv',
      bytes: new TextEncoder().encode('a\n1'),
      purpose: 'import',
    });
    await getDb()
      .update(files)
      .set({ createdAt: sql`now() - interval '2 days'` })
      .where(eq(files.id, orphan.id));
    const expiredFile = await fileOf(expired);

    expect(await app.services.tables.imports.purgeExpired()).toEqual({ deleted: 2, failed: 1, files: 1 });
    const left = await getDb().select({ id: baseImports.id, status: baseImports.status }).from(baseImports);
    expect(Object.fromEntries(left.map((row) => [row.id, row.status]))).toEqual({
      [recent]: 'done',
      [stuck]: 'failed',
      [waiting]: 'queued',
      [fresh]: 'draft',
    });
    expect(await statusOf(expiredFile)).toBe('deleted');
    expect(await statusOf(orphan.id)).toBe('deleted');
    expect(await statusOf(await fileOf(stuck))).toBe('deleted');
    expect(await statusOf(await fileOf(fresh))).toBe('active');
    expect((await as(lin).get(`/api/tables/imports/${stuck}`)).body).toMatchObject({ failure: 'stopped' });
  });

  it('shows an import whose job is gone as failed when it is read', async () => {
    const { lin, as, upload } = await setup();
    const { table } = await blank(as(lin));
    const made = (await upload(lin, table.id, numbered(2))).body;
    await as(lin).post(`/api/tables/imports/${made.id}/start`);
    await setImport(made.id, { updatedAt: sql`now() - interval '3 hours'` });
    // Quiet, but its job still waits: it is only late.
    expect((await as(lin).get(`/api/tables/imports/${made.id}`)).body.status).toBe('queued');
    // The process that held the job died on its last try.
    await getDb().update(jobs).set({ status: 'dead' }).where(eq(jobs.kind, 'base_import'));
    expect((await as(lin).get(`/api/tables/imports/${made.id}`)).body).toMatchObject({
      status: 'failed',
      failure: 'stopped',
    });
  });
});
