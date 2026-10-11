/**
 * Tables imports (slice I) against real PostgreSQL, rolled back per test: the
 * import lifecycle (stage → claim → chunks → complete), exactly-once commits
 * across an interruption and a stale second runner, ownership / expiry, scoped
 * writers, relation matching inside the read scope, history meta and the sweep.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  _resetProvider,
  initDatabase,
  TablesValidationError,
  type DatabaseProvider,
  type TableImportPlan,
  type UserRow,
} from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { fullTableAccess, type TableAccessScope, type TableDataScope } from '@greenhouse/types/table-access';
import type { TableRecordWriteMeta } from '@greenhouse/types/tables';
import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let mate: UserRow;

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  [owner, mate] = await Promise.all([
    createInternalTestUser(db, { email: `tables-i-owner-${tag}@test.local`, nickname: 'Import Owner' }),
    createInternalTestUser(db, { email: `tables-i-mate-${tag}@test.local`, nickname: 'Import Mate' }),
  ]);
});

afterEach(() => {
  _resetProvider();
});

const importMeta = (actorId: string, importId: string): TableRecordWriteMeta => ({
  actorId,
  actorKind: 'import',
  source: { importId },
  enqueueAutomations: false,
});

async function workspace() {
  const base = await db.tables.createBase({ name: 'Imports', owner_id: owner.id, created_by: owner.id });
  const schema = await db.tables.createTable({ base_id: base.id, name: 'Contacts', created_by: owner.id });
  const tableId = schema.table.id;
  const primary = schema.fields[0]!;
  const score = await db.tables.createField({ table_id: tableId, name: 'Score', type: 'number', created_by: owner.id });
  return { base, tableId, primary, score };
}

function planFor(columns: TableImportPlan['columns']): TableImportPlan {
  return { columns, hasHeader: true, createOptions: false, timeZone: 'UTC' };
}

async function stage(tableId: number, userId: string, count: number) {
  return db.tables.createImport({
    table_id: tableId,
    user_id: userId,
    file_name: 'contacts.csv',
    header: ['Name', 'Score'],
    rows: Array.from({ length: count }, (_, index) => [`Person ${index + 1}`, String(index)]),
  });
}

async function countRecords(tableId: number): Promise<number> {
  const rows = (await db.executeRaw(
    sql`SELECT count(*)::int AS n FROM table_records WHERE table_id = ${tableId} AND deleted_at IS NULL`,
  )) as Array<{ n: number }>;
  return rows[0]!.n;
}

/** Chunk items for data rows [from, to) the way the API builds them. */
function chunkItems(w: Awaited<ReturnType<typeof workspace>>, rows: string[][], from: number, to: number) {
  return rows.slice(from, to).map((row, offset) => ({
    row: from + offset + 2,
    values: { [w.primary.id]: row[0], [w.score.id]: Number(row[1]) },
  }));
}

describe('Tables imports — lifecycle', { timeout: 30_000 }, () => {
  it('stages rows without NUL characters and within the limits', async () => {
    const w = await workspace();
    const NUL = String.fromCharCode(0);
    const staged = await db.tables.createImport({
      table_id: w.tableId,
      user_id: owner.id,
      file_name: `bad${NUL}.csv`,
      header: [`Na${NUL}me`],
      rows: [[`A${NUL}da`]],
    });
    expect(staged).toMatchObject({ status: 'previewed', file_name: 'bad.csv', header: ['Name'], rows: [['Ada']] });
    expect(Date.parse(staged.expires_at) - Date.parse(staged.created_at)).toBe(60 * 60 * 1000);
    await expect(
      db.tables.createImport({
        table_id: w.tableId,
        user_id: owner.id,
        file_name: 'wide.csv',
        header: Array.from({ length: 101 }, (_, index) => `c${index}`),
        rows: [],
      }),
    ).rejects.toThrow(/at most 100 columns/);
  });

  it('resumes after an interruption without writing any row twice', async () => {
    const w = await workspace();
    const staged = await stage(w.tableId, owner.id, 250);
    const plan = planFor([
      { column: 0, fieldId: w.primary.id },
      { column: 1, fieldId: w.score.id },
    ]);
    const claim = await db.tables.claimImport({ importId: staged.id, userId: owner.id, tableId: w.tableId, plan });
    expect(claim).toMatchObject({ ok: true, resumed: false });
    const meta = importMeta(owner.id, staged.id);
    const scope = fullTableAccess(owner.id);

    const first = await db.tables.commitImportChunk(
      { importId: staged.id, tableId: w.tableId, fromRow: 0, items: chunkItems(w, staged.rows, 0, 100) },
      scope,
      meta,
    );
    expect(first).toMatchObject({ ok: true, committedRows: 100 });

    // The process dies here: the lease is still held, so a retry is refused…
    const busy = await db.tables.claimImport({ importId: staged.id, userId: owner.id, tableId: w.tableId, plan });
    expect(busy).toMatchObject({ ok: false, reason: 'busy' });
    // …until it expires; the retry resumes with the stored plan, not the new one.
    await db.executeRaw(
      sql`UPDATE table_imports SET lease_expires_at = now() - interval '1 second' WHERE id = ${staged.id}`,
    );
    const resumed = await db.tables.claimImport({
      importId: staged.id,
      userId: owner.id,
      tableId: w.tableId,
      plan: planFor([{ column: 0, fieldId: w.primary.id }]),
    });
    expect(resumed).toMatchObject({ ok: true, resumed: true, plan });
    expect(resumed.ok && resumed.import.committed_rows).toBe(100);

    // A stale runner replaying the first chunk writes nothing.
    const stale = await db.tables.commitImportChunk(
      { importId: staged.id, tableId: w.tableId, fromRow: 0, items: chunkItems(w, staged.rows, 0, 100) },
      scope,
      meta,
    );
    expect(stale).toEqual({ ok: false, reason: 'moved' });
    expect(await countRecords(w.tableId)).toBe(100);

    for (const from of [100, 200]) {
      const chunk = await db.tables.commitImportChunk(
        {
          importId: staged.id,
          tableId: w.tableId,
          fromRow: from,
          items: chunkItems(w, staged.rows, from, Math.min(from + 100, 250)),
        },
        scope,
        meta,
      );
      expect(chunk.ok).toBe(true);
    }
    const done = await db.tables.completeImport(staged.id);
    expect(done).toMatchObject({ status: 'committed', committed_rows: 250, rows: [] });
    expect(await countRecords(w.tableId)).toBe(250);
    const names = (await db.executeRaw(
      sql`SELECT count(DISTINCT values->>${String(w.primary.id)})::int AS n FROM table_records WHERE table_id = ${w.tableId}`,
    )) as Array<{ n: number }>;
    expect(names[0]!.n).toBe(250);

    // Committing again only reports the finished import.
    expect(
      await db.tables.claimImport({ importId: staged.id, userId: owner.id, tableId: w.tableId, plan }),
    ).toMatchObject({ ok: false, reason: 'committed' });
  });

  it('belongs to its uploader and table, and expires', async () => {
    const w = await workspace();
    const other = await db.tables.createTable({ base_id: w.base.id, name: 'Other', created_by: owner.id });
    const staged = await stage(w.tableId, owner.id, 1);
    const plan = planFor([{ column: 0, fieldId: w.primary.id }]);
    expect(await db.tables.claimImport({ importId: staged.id, userId: mate.id, tableId: w.tableId, plan })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(
      await db.tables.claimImport({ importId: staged.id, userId: owner.id, tableId: other.table.id, plan }),
    ).toEqual({ ok: false, reason: 'not_found' });
    expect(
      await db.tables.claimImport({ importId: 'imp_missing', userId: owner.id, tableId: w.tableId, plan }),
    ).toEqual({ ok: false, reason: 'not_found' });

    await db.executeRaw(sql`UPDATE table_imports SET expires_at = now() - interval '1 second' WHERE id = ${staged.id}`);
    expect(
      await db.tables.claimImport({ importId: staged.id, userId: owner.id, tableId: w.tableId, plan }),
    ).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('records failed rows, keeps going, and caps the failure list', async () => {
    const w = await workspace();
    const staged = await stage(w.tableId, owner.id, 3);
    const plan = planFor([{ column: 0, fieldId: w.primary.id }]);
    await db.tables.claimImport({ importId: staged.id, userId: owner.id, tableId: w.tableId, plan });
    const result = await db.tables.commitImportChunk(
      {
        importId: staged.id,
        tableId: w.tableId,
        fromRow: 0,
        items: [
          { row: 2, values: { [w.primary.id]: 'Ada' } },
          // Required primary left empty: refused by the record validator.
          { row: 3, values: {} },
          { row: 4, errors: ['Score: "x" is not a number'] },
        ],
      },
      fullTableAccess(owner.id),
      importMeta(owner.id, staged.id),
    );
    expect(result).toMatchObject({
      ok: true,
      committedRows: 3,
      failed: [
        { row: 3, errors: ['Field "Name" is required'] },
        { row: 4, errors: ['Score: "x" is not a number'] },
      ],
      result: { created: 1, failedCount: 2 },
    });
  });

  it('writes history as the import and never enqueues automations', async () => {
    const w = await workspace();
    const staged = await stage(w.tableId, owner.id, 1);
    await db.tables.claimImport({
      importId: staged.id,
      userId: owner.id,
      tableId: w.tableId,
      plan: planFor([{ column: 0, fieldId: w.primary.id }]),
    });
    const items = [{ row: 2, values: { [w.primary.id]: 'Ada' } }];
    const input = { importId: staged.id, tableId: w.tableId, fromRow: 0, items };
    await expect(
      db.tables.commitImportChunk(input, fullTableAccess(owner.id), {
        ...importMeta(owner.id, staged.id),
        enqueueAutomations: true,
      }),
    ).rejects.toBeInstanceOf(TablesValidationError);
    await expect(
      db.tables.commitImportChunk(input, fullTableAccess(owner.id), {
        actorId: owner.id,
        actorKind: 'user',
        enqueueAutomations: false,
      }),
    ).rejects.toThrow(/import write meta/);

    const result = await db.tables.commitImportChunk(input, fullTableAccess(owner.id), importMeta(owner.id, staged.id));
    expect(result.ok).toBe(true);
    const events = (await db.executeRaw(
      sql`SELECT actor_kind, actor_id, meta FROM table_record_events WHERE table_id = ${w.tableId}`,
    )) as Array<{ actor_kind: string; actor_id: string; meta: Record<string, unknown> }>;
    expect(events).toEqual([{ actor_kind: 'import', actor_id: owner.id, meta: { importId: staged.id } }]);
    const outbox = (await db.executeRaw(
      sql`SELECT count(*)::int AS n FROM table_automation_outbox o JOIN table_records r ON r.id = o.record_id WHERE r.table_id = ${w.tableId}`,
    )) as Array<{ n: number }>;
    expect(outbox[0]!.n).toBe(0);
  });

  it('lets a scoped writer fill only its editable fields', async () => {
    const w = await workspace();
    const staged = await stage(w.tableId, mate.id, 2);
    await db.tables.claimImport({
      importId: staged.id,
      userId: mate.id,
      tableId: w.tableId,
      plan: planFor([{ column: 0, fieldId: w.primary.id }]),
    });
    const scope: TableDataScope = {
      kind: 'scoped',
      userId: mate.id,
      tableId: w.tableId,
      rows: [],
      editRows: [],
      readableFieldIds: [w.primary.id, w.score.id],
      editableFieldIds: [w.primary.id],
      canCreate: true,
      canDelete: false,
    };
    const result = await db.tables.commitImportChunk(
      {
        importId: staged.id,
        tableId: w.tableId,
        fromRow: 0,
        items: [
          { row: 2, values: { [w.primary.id]: 'Ada' } },
          { row: 3, values: { [w.primary.id]: 'Grace', [w.score.id]: 5 } },
        ],
      },
      scope,
      importMeta(mate.id, staged.id),
    );
    expect(result).toMatchObject({
      ok: true,
      failed: [{ row: 3, errors: [`Field ${w.score.id} is not editable`] }],
      result: { created: 1 },
    });
    const wrongTable: TableAccessScope = { ...scope, tableId: w.tableId + 1000 };
    await expect(
      db.tables.commitImportChunk(
        { importId: staged.id, tableId: w.tableId, fromRow: 2, items: [] },
        wrongTable,
        importMeta(mate.id, staged.id),
      ),
    ).rejects.toThrow(/does not cover this table/);
  });

  it('fails a plan for good and sweeps expired imports', async () => {
    const w = await workspace();
    const failing = await stage(w.tableId, owner.id, 1);
    await db.tables.claimImport({
      importId: failing.id,
      userId: owner.id,
      tableId: w.tableId,
      plan: planFor([{ column: 0, create: { name: 'New', type: 'text' } }]),
    });
    const failed = await db.tables.failImport(failing.id, 'Field "New" could not be created');
    expect(failed).toMatchObject({ status: 'failed', rows: [] });

    const expired = await stage(w.tableId, owner.id, 1);
    const running = await stage(w.tableId, owner.id, 1);
    await db.tables.claimImport({
      importId: running.id,
      userId: owner.id,
      tableId: w.tableId,
      plan: planFor([{ column: 0, fieldId: w.primary.id }]),
    });
    await db.executeRaw(
      sql`UPDATE table_imports SET expires_at = now() - interval '1 minute' WHERE id IN (${expired.id}, ${running.id})`,
    );
    // The running commit holds a live lease, so it survives this sweep.
    expect(await db.tables.sweepExpiredImports()).toBe(1);
    expect(await db.tables.getImport(expired.id)).toBeUndefined();
    expect(await db.tables.getImport(running.id)).toBeDefined();
    expect(await db.tables.sweepExpiredImports(new Date(Date.now() + 2 * 60 * 1000))).toBe(1);
  });
});

describe('Tables imports — relation matching', () => {
  it('matches primary text only among records the writer may read', async () => {
    const w = await workspace();
    const create = (name: string, actor: UserRow) =>
      db.tables.createRecord({ table_id: w.tableId, values: { [w.primary.id]: name } }, fullTableAccess(actor.id), {
        actorId: actor.id,
        actorKind: 'user',
        enqueueAutomations: false,
      });
    const acme = await create('Acme', owner);
    const twinA = await create('Twin', owner);
    const twinB = await create('Twin', owner);
    const mine = await create('Mine', mate);

    const all = await db.tables.matchImportRelationLabels(
      w.tableId,
      w.primary.id,
      ['Acme', 'Twin', 'Mine', 'Nope', ''],
      fullTableAccess(owner.id),
    );
    expect(Object.fromEntries(all)).toEqual({
      Acme: [acme.id],
      Twin: expect.arrayContaining([twinA.id, twinB.id]),
      Mine: [mine.id],
    });

    const ownRows: TableDataScope = {
      kind: 'scoped',
      userId: mate.id,
      tableId: w.tableId,
      rows: [{ type: 'related', creator: true, fieldIds: [] }],
      editRows: [],
      readableFieldIds: [w.primary.id],
      editableFieldIds: [],
      canCreate: false,
      canDelete: false,
    };
    const scoped = await db.tables.matchImportRelationLabels(w.tableId, w.primary.id, ['Acme', 'Mine'], ownRows);
    expect(Object.fromEntries(scoped)).toEqual({ Mine: [mine.id] });

    // A hidden primary field matches nothing at all.
    const hiddenPrimary = await db.tables.matchImportRelationLabels(w.tableId, w.primary.id, ['Mine'], {
      ...ownRows,
      readableFieldIds: [],
    });
    expect(hiddenPrimary.size).toBe(0);
  });
});
