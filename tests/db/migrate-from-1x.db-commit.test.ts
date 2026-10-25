/**
 * The 3.0 database generation boundary: `migrate` / boot refuse 1.x and 2.x
 * databases, and `migrate-from-1x` carries a 1.6 fixture database into a fresh
 * 3.0 one with a reconciliation report that accounts for every row.
 *
 * @db-commit-reason Each case creates and drops whole databases (CREATE / DROP
 * DATABASE, the archived 1.x chain, the 3.0 baseline) and compares two
 * databases over separate connections — none of it fits in a rollback
 * transaction.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  applyMigrations,
  carryFrom1x,
  CarryFailedError,
  createDatabase,
  DatabaseGenerationError,
  type CarryReport,
} from '@greenhouse/db';
import {
  TEST_DATABASE_URL,
  buildV1Database,
  dropDatabase,
  queryRows,
  recreateDatabase,
} from '@greenhouse/db/test-config';

const run = randomBytes(4).toString('hex');
const name = (role: string) => `v3db_${role}_${run}_test`;
const NOW = new Date('2026-10-25T00:00:00Z');
const created: string[] = [];

async function database(role: string): Promise<string> {
  const db = name(role);
  created.push(db);
  return recreateDatabase(TEST_DATABASE_URL, db);
}

function line(report: CarryReport, source: string, target?: string) {
  const found = report.lines.find((entry) => entry.source === source && (!target || entry.target === target));
  if (!found) throw new Error(`no report line for ${source}`);
  return found;
}

let source: string;
let target: string;
let report: CarryReport;

beforeAll(async () => {
  source = await database('carry_src');
  await buildV1Database(source);
  target = await database('carry_dst');
  report = await carryFrom1x({ from: source, to: target, now: NOW });
}, 120_000);

afterAll(async () => {
  for (const db of created) await dropDatabase(TEST_DATABASE_URL, db);
}, 120_000);

describe('migrate refuses databases 3.0 must not run on', () => {
  it('refuses a 1.x database and points at migrate-from-1x', async () => {
    const error = await applyMigrations(source).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(DatabaseGenerationError);
    expect((error as Error).message).toContain('migrate-from-1x');
    // Nothing was applied: the 3.0 tables do not exist there.
    expect(await queryRows(source, `SELECT to_regclass('public.conversations') AS t`)).toEqual([{ t: null }]);
  });

  it('refuses a 2.x database', async () => {
    const v2 = await database('v2');
    await queryRows(v2, 'CREATE TABLE members (id text PRIMARY KEY)');
    const error = await applyMigrations(v2).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(DatabaseGenerationError);
    expect((error as Error).message).toContain('2.x');
  });

  it('applies the baseline to an empty database and is a no-op the second time', async () => {
    const fresh = await database('fresh');
    expect((await applyMigrations(fresh)).kind).toBe('empty');
    expect((await applyMigrations(fresh)).kind).toBe('v3');
  });

  it('the API refuses to boot on a 1.x database', async () => {
    const provider = createDatabase(source);
    try {
      await expect(provider.initSchema()).rejects.toThrow(/Greenhouse 1\.x/);
    } finally {
      await provider.close();
    }
  });
});

describe('migrate-from-1x refusals', () => {
  it('refuses a 2.x source', async () => {
    const v2 = await database('v2src');
    await queryRows(v2, 'CREATE TABLE members (id text PRIMARY KEY)');
    await expect(carryFrom1x({ from: v2, to: target })).rejects.toThrow(/2\.x/);
  });

  it('refuses a 1.x source that is not on 1.6 yet', async () => {
    const old = await database('oldsrc');
    await buildV1Database(old, { seed: false });
    await queryRows(
      old,
      `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM drizzle.__drizzle_migrations)`,
    );
    await expect(carryFrom1x({ from: old, to: target })).rejects.toThrow(/upgrade it to 1\.6/);
  });

  it('refuses a 1.x target and the same database twice', async () => {
    await expect(carryFrom1x({ from: source, to: source })).rejects.toThrow(/same database/);
    const other = await database('v1dst');
    await buildV1Database(other, { seed: false });
    await expect(carryFrom1x({ from: source, to: other })).rejects.toThrow(/empty or a 3\.0 database/);
  });
});

describe('migrate-from-1x carry', () => {
  it('accounts for every source row', () => {
    for (const entry of report.lines) {
      const skipped = Object.values(entry.skipped).reduce((sum, count) => sum + count, 0);
      expect(entry.read, `${entry.source} → ${entry.target}`).toBe(entry.written + skipped);
    }
    expect(report.notes.join('\n')).not.toMatch(/has no carry rule/);
  });

  it('keeps ids (serials become strings) and the users, without the retired workbench', async () => {
    expect(await queryRows(target, `SELECT id, preferences FROM users ORDER BY id`)).toEqual([
      { id: 'u-ann', preferences: {} },
      { id: 'u-bob', preferences: {} },
    ]);
    expect(await queryRows(target, `SELECT id, title FROM kb_documents ORDER BY id`)).toEqual([
      { id: '1', title: 'Guide' },
      { id: '2', title: 'Private' },
    ]);
    expect(await queryRows(target, `SELECT kind, key, enabled FROM user_grants ORDER BY kind`)).toEqual([
      { kind: 'feature', key: 'memory', enabled: false },
      { kind: 'tool', key: 'web_search', enabled: true },
    ]);
  });

  it('skips what A4 leaves behind, with reasons', () => {
    expect(line(report, 'refresh_tokens').skipped).toEqual({ 'expired token': 1 });
    expect(line(report, 'platform_oauth_tokens').skipped).toEqual({ 'expired token': 1 });
    expect(line(report, 'runtime_events').skipped).toEqual({ 'run event older than 30 days': 1 });
    expect(line(report, 'runtime_outbox').skipped).toEqual({ 'delivered outbox': 1 });
    expect(line(report, 'api_audit_log').skipped).toEqual({ 'request log older than 30 days': 1 });
    expect(line(report, 'knowledge_base_shares').skipped).toEqual({ 'shared with a user group (removed in 3.0)': 1 });
    const retired = Object.fromEntries(report.retired.map((entry) => [entry.table, entry.rows]));
    expect(retired).toMatchObject({
      eval_datasets: 1,
      kb_comments: 1,
      table_dashboards: 1,
      rate_limit_buckets: 1,
      platform_user_workbench_preferences: 1,
    });
  });

  it('keeps an old event whose outbox row still waits, and every event of an active run', async () => {
    expect((await queryRows(target, `SELECT id FROM run_events ORDER BY id`)).map((row) => row.id)).toEqual([
      'e-live',
      'e-new',
      'e-old-pending',
    ]);
    expect(await queryRows(target, `SELECT id, status FROM run_outbox`)).toEqual([{ id: 'o-wait', status: 'pending' }]);
  });

  it('turns JSON text into jsonb and moves pins onto conversations and read rows', async () => {
    expect(
      await queryRows(
        target,
        `SELECT id, pin_position, pinned_at IS NOT NULL AS pinned FROM conversations ORDER BY id`,
      ),
    ).toEqual([
      { id: 's-ann', pin_position: 1, pinned: true },
      { id: 's-bob', pin_position: 0, pinned: false },
    ]);
    expect(
      await queryRows(
        target,
        `SELECT user_id, pinned_at IS NOT NULL AS pinned, read_at IS NOT NULL AS read FROM conversation_share_reads`,
      ),
    ).toEqual([{ user_id: 'u-bob', pinned: true, read: true }]);
    const [message] = await queryRows(target, `SELECT parts FROM messages WHERE id = 'm2'`);
    // The NUL escape is dropped (jsonb cannot hold U+0000); the rest survives.
    expect(message!.parts).toEqual({ references: [{ doc_id: 1 }], pipeline: [{ type: 'tool', output: 'badbyte' }] });
    // A lone surrogate escape (a cut emoji) becomes U+FFFD instead of failing the insert.
    expect(await queryRows(target, `SELECT parts FROM messages WHERE id = 'm3'`)).toEqual([
      { parts: { references: [{ title: 'half \uFFFD' }] } },
    ]);
    expect(await queryRows(target, `SELECT notify, unattended_tools FROM automations`)).toEqual([
      {
        notify: { webhook: 'https://hook.example.test', email: true, wecom: false, feishu: true },
        unattended_tools: ['knowledge_mutation'],
      },
    ]);
  });

  it('rewrites table ids inside configs and cells as strings', async () => {
    expect(await queryRows(target, `SELECT config FROM table_fields WHERE id = '2'`)).toEqual([
      { config: { relation: { targetTableId: '1', multiple: true } } },
    ]);
    expect(await queryRows(target, `SELECT config FROM table_views`)).toEqual([
      { config: { fieldIds: ['1', '2'], query: { sort: [{ fieldId: '1', direction: 'asc' }] } } },
    ]);
    expect(await queryRows(target, `SELECT values FROM table_records WHERE id = '1'`)).toEqual([
      { values: { '1': 'Acme', '2': ['2'], '3': ['1'] } },
    ]);
    expect(await queryRows(target, `SELECT file_id, target_type, target_id, slot FROM file_links`)).toEqual([
      { file_id: '1', target_type: 'table_record', target_id: '1', slot: '3' },
    ]);
    expect(
      await queryRows(target, `SELECT resource_type, resource_id, principal_id, role FROM shares ORDER BY id`),
    ).toEqual([
      { resource_type: 'kb_document', resource_id: '2', principal_id: 'u-ann', role: 'reader' },
      { resource_type: 'table_base', resource_id: '1', principal_id: 'u-bob', role: 'editor' },
    ]);
  });

  it('merges tables with their source recorded', async () => {
    expect(await queryRows(target, `SELECT id, kind FROM usage_events ORDER BY kind`)).toEqual([
      { id: 'lc-1', kind: 'audit' },
      { id: '1', kind: 'model' },
      { id: 'svu-1', kind: 'service' },
    ]);
    expect(
      (await queryRows(target, `SELECT id, app_id FROM audit_events ORDER BY id`)).map(
        (row) => `${row.id}:${row.app_id}`,
      ),
    ).toEqual(['a1:knowledge', 'esl_1:email', 'pac_1:projects']);
    expect(await queryRows(target, `SELECT id, kind FROM feedback ORDER BY id`)).toEqual([
      { id: '1', kind: 'request' },
      { id: 'frc_1', kind: 'friction' },
    ]);
    expect(
      await queryRows(target, `SELECT source, count(*)::int AS n FROM files GROUP BY source ORDER BY source`),
    ).toEqual([
      { source: 'chat_upload', n: 1 },
      { source: 'drive', n: 2 },
      { source: 'run', n: 1 },
    ]);
    expect(await queryRows(target, `SELECT version, risk_level, purpose FROM run_profiles`)).toEqual([
      { version: 2, risk_level: 'high', purpose: 'research' },
    ]);
  });

  it('copies extension tables verbatim, with their sequences and keys', async () => {
    expect(report.extensions.map((entry) => `${entry.table}:${entry.rows}`)).toEqual([
      'crm_companies:1',
      'crm_contacts:1',
      'extension_migrations:1',
    ]);
    expect(await queryRows(target, `SELECT nextval('crm_companies_id_seq') AS next`)).toEqual([{ next: '43' }]);
    await expect(queryRows(target, `INSERT INTO crm_contacts (company_id, email) VALUES (999, 'x')`)).rejects.toThrow(
      /foreign key/,
    );
    expect(await queryRows(target, `SELECT extension_id, name FROM extension_migrations`)).toEqual([
      { extension_id: 'crm', name: '0001_baseline.sql' },
    ]);
  });

  it('is repeatable: a second run empties the target first and lands the same counts', async () => {
    await queryRows(target, `INSERT INTO prompts (id, user_id, title, content) VALUES ('stray', 'u-ann', 'x', 'y')`);
    const again = await carryFrom1x({ from: source, to: target, now: NOW });
    expect(again.targetCounts).toEqual(report.targetCounts);
    expect(await queryRows(target, `SELECT id FROM prompts WHERE id = 'stray'`)).toEqual([]);
  });

  it('carries a child task that comes batches before its parent, and clears a parent it skips', async () => {
    const src = await database('tasks_src');
    await buildV1Database(src);
    // Replica mode skips the FK triggers so the child can sit physically before its parent.
    const fillers = Array.from({ length: 600 }, (_, i) => `(${101 + i}, 1, NULL, 'f${i}', 'u-ann', now(), now())`).join(
      ', ',
    );
    await queryRows(
      src,
      `SET session_replication_role = replica;
       INSERT INTO tasks (id, project_id, parent_id, title, created_by, created_at, updated_at) VALUES (100, 1, 2000, 'child', 'u-ann', now(), now());
       INSERT INTO tasks (id, project_id, parent_id, title, created_by, created_at, updated_at) VALUES ${fillers};
       INSERT INTO tasks (id, project_id, parent_id, title, created_by, created_at, updated_at) VALUES (2000, 1, NULL, 'parent', 'u-ann', now(), now());
       INSERT INTO tasks (id, project_id, parent_id, title, created_by, created_at, updated_at) VALUES (3000, 999, NULL, 'orphan parent', 'u-ann', now(), now());
       INSERT INTO tasks (id, project_id, parent_id, title, created_by, created_at, updated_at) VALUES (3001, 1, 3000, 'orphan child', 'u-ann', now(), now());`,
    );
    const dst = await database('tasks_dst');
    const carried = await carryFrom1x({ from: src, to: dst, now: NOW });
    expect(line(carried, 'tasks').skipped).toEqual({ 'project not carried': 1 });
    expect(
      await queryRows(dst, `SELECT id, parent_id FROM tasks WHERE id IN ('2', '100', '3001') ORDER BY id`),
    ).toEqual([
      { id: '100', parent_id: '2000' },
      { id: '2', parent_id: '1' },
      { id: '3001', parent_id: null },
    ]);
  }, 120_000);

  it('marks a finished carry complete; a fresh install has no marker and boots', async () => {
    expect(await queryRows(target, `SELECT completed_at IS NOT NULL AS done FROM drizzle.greenhouse_carry`)).toEqual([
      { done: true },
    ]);
    const fresh = await database('nomarker');
    await applyMigrations(fresh);
    expect(await queryRows(fresh, `SELECT to_regclass('drizzle.greenhouse_carry')::text AS t`)).toEqual([{ t: null }]);
    expect((await applyMigrations(fresh)).kind).toBe('v3');
    const provider = createDatabase(fresh);
    try {
      await expect(provider.initSchema()).resolves.toBeUndefined();
    } finally {
      await provider.close();
    }
  });

  it('a carry that fails midway leaves the target refused until a re-run completes it', async () => {
    const dst = await database('half');
    await carryFrom1x({ from: source, to: dst, now: NOW });
    // TRUNCATE keeps triggers: the re-run empties the target, then dies writing tasks.
    await queryRows(
      dst,
      `CREATE FUNCTION fail_carry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$;
       CREATE TRIGGER fail_carry BEFORE INSERT ON tasks FOR EACH STATEMENT EXECUTE FUNCTION fail_carry();`,
    );
    const failure = await carryFrom1x({ from: source, to: dst, now: NOW }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(CarryFailedError);
    expect((failure as Error).message).toMatch(/Writing tasks failed.*injected[\s\S]*re-run migrate-from-1x/);
    expect(await queryRows(dst, `SELECT completed_at FROM drizzle.greenhouse_carry`)).toEqual([{ completed_at: null }]);

    const refused = await applyMigrations(dst).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(DatabaseGenerationError);
    expect((refused as Error).message).toMatch(/did not complete[\s\S]*migrate-from-1x/);
    const provider = createDatabase(dst);
    try {
      await expect(provider.initSchema()).rejects.toThrow(/did not complete/);
    } finally {
      await provider.close();
    }

    await queryRows(dst, `DROP TRIGGER fail_carry ON tasks; DROP FUNCTION fail_carry();`);
    const again = await carryFrom1x({ from: source, to: dst, now: NOW });
    expect(again.targetCounts).toEqual(report.targetCounts);
    expect((await applyMigrations(dst)).kind).toBe('v3');
  }, 120_000);

  it('a dry run reads and reports but writes nothing', async () => {
    const empty = await database('dry');
    const dry = await carryFrom1x({ from: source, to: empty, dryRun: true, now: NOW });
    expect(dry.dryRun).toBe(true);
    expect(line(dry, 'users').written).toBe(2);
    expect(await queryRows(empty, `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`)).toEqual([
      { n: 0 },
    ]);
  });
});
