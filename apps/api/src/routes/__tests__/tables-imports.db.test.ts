/**
 * Tables import over HTTP (slice I, real PostgreSQL): upload → preview →
 * dry run → commit (new fields, failed rows, relations), exactly once across
 * double commits and an interrupted commit, ownership, expiry and who may
 * create fields.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import ExcelJS from 'exceljs';
import { sql } from 'drizzle-orm';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { fullTableAccess } from '@greenhouse/types/table-access';
import type {
  TableBaseRole,
  TableImportMapping,
  TableImportPreview,
  TableImportProgress,
  TableImportValidation,
} from '@greenhouse/types/tables';
import type { AppEnv } from '../../app-env.js';
import tablesRoutes from '../tables/index.js';
import { tablesRegistration } from '../../platform/tables/application.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let editor: UserRow;
let outsider: UserRow;

function createHttpApp(users: UserRow[]) {
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

type App = ReturnType<typeof createHttpApp>;

function send(app: App, user: UserRow, path: string, method = 'GET', body?: unknown) {
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': user.id },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function upload(app: App, user: UserRow, tableId: number, name: string, bytes: Uint8Array) {
  const form = new FormData();
  form.append('file', new File([Uint8Array.from(bytes)], name));
  return app.request(`/api/tables/tables/${tableId}/imports`, {
    method: 'POST',
    headers: { 'x-test-user': user.id },
    body: form,
  });
}

const csv = (text: string) => new TextEncoder().encode(text);

/** The few Chinese characters the GBK fixture uses, as a Chinese Excel would save them. */
const GBK_CODES: Record<string, [number, number]> = {
  华: [0xbb, 0xaa],
  北: [0xb1, 0xb1],
  南: [0xc4, 0xcf],
  客: [0xbf, 0xcd],
  户: [0xbb, 0xa7],
  地: [0xb5, 0xd8],
  区: [0xc7, 0xf8],
};

function gbk(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 0x80) bytes.push(code);
    else bytes.push(...GBK_CODES[char]!);
  }
  return Uint8Array.from(bytes);
}

async function workspace(app: App) {
  const response = await send(app, owner, '/api/tables/bases', 'POST', { name: 'Import Base' });
  expect(response.status).toBe(201);
  const created = (await response.json()) as {
    base: { id: number };
    schema: { table: { id: number }; fields: Array<{ id: number }> };
  };
  const tableId = created.schema.table.id;
  const field = async (name: string, type: string, config?: unknown) => {
    const res = await send(app, owner, `/api/tables/tables/${tableId}/fields`, 'POST', { name, type, config });
    expect(res.status).toBe(201);
    return ((await res.json()) as { field: { id: number } }).field.id;
  };
  const amount = await field('Amount', 'number');
  const status = await field('Status', 'single_select', {
    options: [
      { id: 'open', label: 'Open' },
      { id: 'won', label: 'Won' },
    ],
  });
  return { baseId: created.base.id, tableId, primaryId: created.schema.fields[0]!.id, amount, status };
}

async function addMember(app: App, baseId: number, user: UserRow, role: TableBaseRole) {
  const response = await send(app, owner, `/api/tables/bases/${baseId}/members/${user.id}`, 'PUT', { role });
  expect(response.status).toBe(200);
}

async function preview(app: App, user: UserRow, tableId: number, name: string, bytes: Uint8Array) {
  const response = await upload(app, user, tableId, name, bytes);
  expect(response.status).toBe(201);
  return (await response.json()) as TableImportPreview;
}

/** Call commit until the import is finished, like the wizard does. */
async function commitAll(app: App, user: UserRow, tableId: number, importId: string, body: Record<string, unknown>) {
  for (let call = 0; call < 50; call += 1) {
    const response = await send(app, user, `/api/tables/tables/${tableId}/imports/${importId}/commit`, 'POST', body);
    expect(response.status).toBe(200);
    const progress = (await response.json()) as TableImportProgress;
    if (progress.status !== 'committing') return progress;
  }
  throw new Error('import did not finish');
}

async function recordCount(tableId: number): Promise<number> {
  const rows = (await db.executeRaw(
    sql`SELECT count(*)::int AS n FROM table_records WHERE table_id = ${tableId} AND deleted_at IS NULL`,
  )) as Array<{ n: number }>;
  return rows[0]!.n;
}

// Real writes through the whole stack (2,000 rows in one case): generous limits for a loaded machine.
describe('Tables import — HTTP', { timeout: 60_000 }, () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    [owner, editor, outsider] = await Promise.all([
      createInternalTestUser(db, { email: `tables-imp-owner-${tag}@test.local`, nickname: 'Imp Owner' }),
      createInternalTestUser(db, { email: `tables-imp-editor-${tag}@test.local`, nickname: 'Imp Editor' }),
      createInternalTestUser(db, { email: `tables-imp-outsider-${tag}@test.local`, nickname: 'Imp Outsider' }),
    ]);
    initializePlatformRuntime(db, [tablesRegistration]);
  });

  afterEach(async () => {
    resetPlatformRuntimeForTests();
    await db.close();
    _resetProvider();
  });

  it(
    'imports a 2,000-row GBK CSV into existing and new fields, reporting failed rows',
    { timeout: 300_000 },
    async () => {
      const app = createHttpApp([owner]);
      const w = await workspace(app);
      const lines = ['Name,Amount,Status,地区,Signed'];
      for (let index = 1; index <= 2_000; index += 1) {
        const amount = index === 7 ? 'lots' : `${(index * 1_000).toLocaleString('en-US')}`;
        const status = index % 2 ? 'Open' : 'won';
        lines.push(`客户 ${index},"${amount}",${status},${index % 3 ? '华北' : '华南'},2024-03-${(index % 28) + 1}`);
      }
      const staged = await preview(app, owner, w.tableId, 'deals.csv', gbk(lines.join('\r\n')));
      expect(staged).toMatchObject({ fileName: 'deals.csv', rowCount: 2_000 });
      expect(staged.columns.map((column) => column.suggestion)).toEqual([
        { fieldId: w.primaryId },
        { fieldId: w.amount },
        { fieldId: w.status },
        { create: { name: '地区', type: 'single_select' } },
        { create: { name: 'Signed', type: 'date' } },
      ]);

      const mapping: TableImportMapping[] = staged.columns.map((column) =>
        column.suggestion && 'fieldId' in column.suggestion
          ? { column: column.index, fieldId: column.suggestion.fieldId }
          : { column: column.index, create: (column.suggestion as { create: { name: string; type: 'text' } }).create },
      );
      const base = `/api/tables/tables/${w.tableId}/imports/${staged.importId}`;
      const validate = await send(app, owner, `${base}/validate`, 'POST', { mapping, hasHeader: true });
      expect(validate.status).toBe(200);
      expect((await validate.json()) as TableImportValidation).toEqual({
        totalRows: 2_000,
        validRows: 1_999,
        failed: [{ row: 8, errors: ['Amount: "lots" is not a number'] }],
        failedCount: 1,
        missingRequired: [],
      });
      expect(await recordCount(w.tableId)).toBe(0);

      const done = await commitAll(app, owner, w.tableId, staged.importId, { mapping, hasHeader: true });
      expect(done).toMatchObject({
        status: 'committed',
        totalRows: 2_000,
        processedRows: 2_000,
        result: { created: 1_999, failedCount: 1, failed: [{ row: 8, errors: ['Amount: "lots" is not a number'] }] },
      });
      expect(done.result.createdFieldIds).toHaveLength(2);
      expect(await recordCount(w.tableId)).toBe(1_999);

      const schema = (await (await send(app, owner, `/api/tables/tables/${w.tableId}/schema`)).json()) as {
        fields: Array<{ id: number; name: string; type: string; config: string }>;
      };
      const region = schema.fields.find((field) => field.name === '地区')!;
      expect(region.type).toBe('single_select');
      expect(JSON.parse(region.config).options.map((option: { label: string }) => option.label)).toEqual([
        '华北',
        '华南',
      ]);
      const query = (await (
        await send(app, owner, `/api/tables/tables/${w.tableId}/records/query`, 'POST', {
          where: { combinator: 'and', clauses: [{ fieldId: w.primaryId, operator: 'eq', value: '客户 2' }] },
        })
      ).json()) as { records: Array<{ values: Record<string, unknown> }> };
      const signed = schema.fields.find((field) => field.name === 'Signed')!;
      const southId = JSON.parse(region.config).options[1].id as string;
      expect(query.records[0]!.values).toMatchObject({
        [w.amount]: 2_000,
        [w.status]: 'won',
        [region.id]: expect.any(String),
        [signed.id]: '2024-03-03',
      });
      expect(query.records[0]!.values[region.id]).not.toBe(southId);

      // Committing again only reports the finished import.
      const again = await commitAll(app, owner, w.tableId, staged.importId, { mapping, hasHeader: true });
      expect(again).toMatchObject({ status: 'committed', result: { created: 1_999 } });
      expect(await recordCount(w.tableId)).toBe(1_999);
    },
  );

  it('imports one row once even when commit is pressed twice at the same time', async () => {
    const app = createHttpApp([owner]);
    const w = await workspace(app);
    const staged = await preview(app, owner, w.tableId, 'x.csv', csv('Name\nAda\nGrace\nLinus\n'));
    const body = { mapping: [{ column: 0, fieldId: w.primaryId }], hasHeader: true };
    const path = `/api/tables/tables/${w.tableId}/imports/${staged.importId}/commit`;
    const responses = await Promise.all([send(app, owner, path, 'POST', body), send(app, owner, path, 'POST', body)]);
    const statuses = responses.map((response) => response.status).sort();
    expect([
      [200, 200],
      [200, 409],
    ]).toContainEqual(statuses);
    await commitAll(app, owner, w.tableId, staged.importId, body);
    expect(await recordCount(w.tableId)).toBe(3);
  });

  it('resumes an interrupted commit with its stored plan and no duplicates', async () => {
    const app = createHttpApp([owner]);
    const w = await workspace(app);
    const lines = ['Name,Amount', ...Array.from({ length: 250 }, (_, index) => `Row ${index},${index}`)];
    const staged = await preview(app, owner, w.tableId, 'big.csv', csv(lines.join('\n')));
    const plan = {
      columns: [
        { column: 0, fieldId: w.primaryId },
        { column: 1, fieldId: w.amount },
      ],
      hasHeader: true,
      createOptions: false,
      timeZone: 'UTC',
    };
    // A commit that wrote one chunk and died with its lease still held.
    const claim = await db.tables.claimImport({
      importId: staged.importId,
      userId: owner.id,
      tableId: w.tableId,
      plan,
    });
    expect(claim.ok).toBe(true);
    const chunk = await db.tables.commitImportChunk(
      {
        importId: staged.importId,
        tableId: w.tableId,
        fromRow: 0,
        items: Array.from({ length: 100 }, (_, index) => ({
          row: index + 2,
          values: { [w.primaryId]: `Row ${index}`, [w.amount]: index },
        })),
      },
      fullTableAccess(owner.id),
      { actorId: owner.id, actorKind: 'import', source: { importId: staged.importId }, enqueueAutomations: false },
    );
    expect(chunk.ok).toBe(true);

    const path = `/api/tables/tables/${w.tableId}/imports/${staged.importId}/commit`;
    // The retry asks to import only the name column; the stored plan wins.
    const body = { mapping: [{ column: 0, fieldId: w.primaryId }], hasHeader: true };
    const busy = await send(app, owner, path, 'POST', body);
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ details: { reason: 'import_in_progress' } });

    await db.executeRaw(
      sql`UPDATE table_imports SET lease_expires_at = now() - interval '1 second' WHERE id = ${staged.importId}`,
    );
    const done = await commitAll(app, owner, w.tableId, staged.importId, body);
    expect(done).toMatchObject({ status: 'committed', processedRows: 250, result: { created: 250 } });
    expect(await recordCount(w.tableId)).toBe(250);
    const amounts = (await db.executeRaw(
      sql`SELECT count(*)::int AS n FROM table_records WHERE table_id = ${w.tableId} AND values ? ${String(w.amount)}`,
    )) as Array<{ n: number }>;
    expect(amounts[0]!.n).toBe(250);
  });

  it("answers 404 for someone else's import and refuses an expired one", async () => {
    const app = createHttpApp([owner, editor, outsider]);
    const w = await workspace(app);
    await addMember(app, w.baseId, editor, 'editor');
    const staged = await preview(app, owner, w.tableId, 'x.csv', csv('Name\nAda\n'));
    const body = { mapping: [{ column: 0, fieldId: w.primaryId }], hasHeader: true };
    const base = `/api/tables/tables/${w.tableId}/imports/${staged.importId}`;

    expect((await send(app, editor, `${base}/commit`, 'POST', body)).status).toBe(404);
    expect((await send(app, editor, `${base}/validate`, 'POST', body)).status).toBe(404);
    expect((await send(app, outsider, `${base}/commit`, 'POST', body)).status).toBe(404);
    expect((await upload(app, outsider, w.tableId, 'x.csv', csv('Name\nAda\n'))).status).toBe(404);

    await db.executeRaw(
      sql`UPDATE table_imports SET expires_at = now() - interval '1 second' WHERE id = ${staged.importId}`,
    );
    const expired = await send(app, owner, `${base}/commit`, 'POST', body);
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({ details: { reason: 'import_expired' } });
    expect(await recordCount(w.tableId)).toBe(0);
  });

  it('lets an editor import into fields but never create fields or options', async () => {
    const app = createHttpApp([owner, editor]);
    const w = await workspace(app);
    await addMember(app, w.baseId, editor, 'editor');
    const staged = await preview(app, editor, w.tableId, 'x.csv', csv('Name,Status,Note\nAda,Lost,hi\n'));
    // No "create" suggestions for someone who cannot build.
    expect(staged.columns.map((column) => column.suggestion)).toEqual([
      { fieldId: w.primaryId },
      { fieldId: w.status },
      undefined,
    ]);
    const path = `/api/tables/tables/${w.tableId}/imports/${staged.importId}/commit`;
    const create = await send(app, editor, path, 'POST', {
      mapping: [
        { column: 0, fieldId: w.primaryId },
        { column: 2, create: { name: 'Note', type: 'text' } },
      ],
      hasHeader: true,
    });
    expect(create.status).toBe(403);
    const options = await send(app, editor, path, 'POST', {
      mapping: [{ column: 1, fieldId: w.status }],
      hasHeader: true,
      createOptions: true,
    });
    expect(options.status).toBe(403);

    const done = await commitAll(app, editor, w.tableId, staged.importId, {
      mapping: [
        { column: 0, fieldId: w.primaryId },
        { column: 1, fieldId: w.status },
      ],
      hasHeader: true,
    });
    expect(done.result).toMatchObject({
      created: 0,
      failed: [{ row: 2, errors: ['Status: "Lost" is not an option'] }],
    });
    const schema = (await (await send(app, owner, `/api/tables/tables/${w.tableId}/schema`)).json()) as {
      fields: Array<{ name: string }>;
    };
    expect(schema.fields.map((field) => field.name)).toEqual(['Name', 'Amount', 'Status']);
  });

  it('adds missing options for builders and links records by their primary text', async () => {
    const app = createHttpApp([owner]);
    const w = await workspace(app);
    const companies = (await (
      await send(app, owner, `/api/tables/bases/${w.baseId}/tables`, 'POST', { name: 'Companies' })
    ).json()) as { table: { id: number }; fields: Array<{ id: number }> };
    for (const name of ['Acme', 'Globex']) {
      await send(app, owner, `/api/tables/tables/${companies.table.id}/records`, 'POST', {
        values: { [companies.fields[0]!.id]: name },
      });
    }
    const link = (await (
      await send(app, owner, `/api/tables/tables/${w.tableId}/fields`, 'POST', {
        name: 'Company',
        type: 'relation',
        config: { relation: { targetTableId: companies.table.id } },
      })
    ).json()) as { field: { id: number } };

    const staged = await preview(
      app,
      owner,
      w.tableId,
      'x.csv',
      csv('Name,Status,Company\nOne,Lost,Acme\nTwo,Won,Globex\nThree,Open,Initech\n'),
    );
    const done = await commitAll(app, owner, w.tableId, staged.importId, {
      mapping: [
        { column: 0, fieldId: w.primaryId },
        { column: 1, fieldId: w.status },
        { column: 2, fieldId: link.field.id },
      ],
      hasHeader: true,
      createOptions: true,
    });
    expect(done.result).toMatchObject({
      created: 2,
      failed: [{ row: 4, errors: ['Company: no linked record named "Initech"'] }],
    });
    const status = (await db.tables.getField(w.status))!;
    expect(JSON.parse(status.config).options.map((option: { label: string }) => option.label)).toEqual([
      'Open',
      'Won',
      'Lost',
    ]);
  });

  it('imports an .xlsx workbook', async () => {
    const app = createHttpApp([owner]);
    const w = await workspace(app);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Deals');
    sheet.addRow(['Name', 'Amount']);
    sheet.addRow([{ richText: [{ text: 'Rich ' }, { text: 'deal' }] }, { formula: '2*21', result: 42 }]);
    sheet.addRow(['Plain', 7]);
    const staged = await preview(
      app,
      owner,
      w.tableId,
      'deals.xlsx',
      new Uint8Array(await workbook.xlsx.writeBuffer()),
    );
    expect(staged.columns[0]!.samples).toEqual(['Rich deal', 'Plain']);
    const done = await commitAll(app, owner, w.tableId, staged.importId, {
      mapping: [
        { column: 0, fieldId: w.primaryId },
        { column: 1, fieldId: w.amount },
      ],
      hasHeader: true,
    });
    expect(done.result).toMatchObject({ created: 2, failedCount: 0 });
  });

  it('refuses unreadable uploads with a message', async () => {
    const app = createHttpApp([owner]);
    const w = await workspace(app);
    const bad = await upload(app, owner, w.tableId, 'notes.pdf', csv('x'));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Import a .csv, .tsv or .xlsx file' });
    const empty = await upload(app, owner, w.tableId, 'empty.csv', csv('\n\n'));
    expect(await empty.json()).toEqual({ error: 'The file has no rows' });
  });
});
