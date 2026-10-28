/**
 * @db-commit-reason The in-place 3.x → 4.0 bridge runs on whole databases through the
 * real migration entrypoint and the boot check, across separate connections.
 *
 * A 3.0.2 install that was carried from 1.x and runs a private overlay must come
 * through with every row intact: legacy CHECK values, the carry marker, overlay
 * tables and their lane rows. 1.x / 2.x databases are refused with what to do instead.
 */
import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyAllMigrations, createDatabase, DatabaseGenerationError } from '@greenhouse/db';
import {
  TEST_DATABASE_URL,
  buildV3Database,
  dropDatabase,
  queryRows,
  recreateDatabase,
} from '@greenhouse/db/test-config';

const root = resolve(import.meta.dirname, '../..');
const fixture = (name: string) => readFileSync(join(root, 'tests/fixtures', name), 'utf8');
const officialSources = readdirSync(join(root, 'plugins'))
  .sort()
  .flatMap((id) => {
    const dir = join(root, 'plugins', id, 'migrations');
    return existsSync(dir) ? [{ extensionId: id, dir }] : [];
  });

async function withDatabase<T>(label: string, run: (url: string) => Promise<T>): Promise<T> {
  const name = `gh4_schema_${label}_${randomBytes(4).toString('hex')}_test`;
  const url = await recreateDatabase(TEST_DATABASE_URL, name);
  try {
    return await run(url);
  } finally {
    await dropDatabase(TEST_DATABASE_URL, name);
  }
}

/** Row count + fingerprint of every public table, plus the bookkeeping the bridge must not touch. */
async function inventory(url: string) {
  const tables = (await queryRows(url, `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map(
    (row) => String(row.tablename),
  );
  const out: Record<string, { count: number; hash: string }> = {};
  for (const table of tables) {
    const where = table === 'extension_migrations' ? `WHERE extension_id IN ('crm', 'sellfox')` : '';
    // Core migration 0003 rewrites retired profile ids (canonical-profile-ids.db-commit.test.ts).
    const row = table === 'conversations' ? `to_jsonb(t) - 'profile_id'` : 'to_jsonb(t)';
    const rows = await queryRows(url, `SELECT ${row}::text AS row FROM "${table}" t ${where} ORDER BY 1`);
    out[table] = { count: rows.length, hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
  }
  out['drizzle.greenhouse_carry'] = {
    count: 1,
    hash: JSON.stringify(await queryRows(url, 'SELECT to_jsonb(c)::text AS row FROM drizzle.greenhouse_carry c')),
  };
  return out;
}

describe('3.x → 4.0 in-place bridge', () => {
  it('keeps every row of a carried 3.0.2 install with a private overlay, and the boot check passes', async () => {
    await withDatabase('carried', async (url) => {
      await buildV3Database(url);
      await queryRows(url, fixture('plugin-upgrade-v3.sql'));
      await queryRows(url, fixture('v3-carried-install.sql'));
      const before = await inventory(url);
      expect(before.crm_accounts?.count).toBe(1);
      expect(before.extension_migrations?.count).toBe(3);

      // The boot refuses a 3.x database until `pnpm db:migrate` has bridged it.
      const booting = createDatabase(url);
      await expect(booting.initSchema()).rejects.toThrow(/still on the Greenhouse 3\.x schema[\s\S]*pnpm db:migrate/);
      await booting.close();

      const result = await applyAllMigrations(url, { extensionSources: officialSources });
      expect(result.generation.kind).toBe('v3');
      expect(result.bridged?.archived.at(-1)).toBe('0009_knowledge_plugin_ownership');
      const after = await inventory(url);
      expect(Object.fromEntries(Object.keys(before).map((table) => [table, after[table]]))).toEqual(before);
      // The only new tables are 4.0's own core addition and the Example lane's (3.0.2 never had either).
      expect(Object.keys(after).filter((table) => !(table in before))).toEqual(['client_reports', 'ext_example_notes']);
      expect(await queryRows(url, `SELECT DISTINCT profile_id FROM conversations`)).toEqual([{ profile_id: 'sprouty' }]);

      // No constraint was left unvalidated; the legacy values are still there.
      expect(
        await queryRows(
          url,
          `SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
           WHERE n.nspname = 'public' AND NOT c.convalidated`,
        ),
      ).toEqual([]);
      expect(await queryRows(url, `SELECT kind FROM runs WHERE id LIKE 'carried-run-%' ORDER BY kind`)).toEqual([
        { kind: 'eval' },
        { kind: 'mission' },
        { kind: 'subagent' },
        { kind: 'workflow' },
      ]);

      const booted = createDatabase(url);
      await expect(booted.initSchema()).resolves.toBeUndefined();
      await booted.close();
    });
  }, 60_000);

  it('a fresh 4.0 database accepts every legacy value a carried install holds', async () => {
    await withDatabase('legacy', async (url) => {
      await applyAllMigrations(url, { extensionSources: officialSources });
      await queryRows(url, fixture('plugin-upgrade-v3.sql'));
      await queryRows(url, fixture('v3-carried-install.sql'));
      expect(await queryRows(url, `SELECT role FROM users WHERE id = 'carried-external'`)).toEqual([
        { role: 'external' },
      ]);
    });
  }, 60_000);

  it('refuses 1.x (via 3.0.2), 2.x (fresh install) and half-carried databases', async () => {
    await withDatabase('v1', async (url) => {
      await queryRows(url, 'CREATE TABLE users (id serial PRIMARY KEY); CREATE TABLE sessions (id serial PRIMARY KEY)');
      const error = await applyAllMigrations(url).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(DatabaseGenerationError);
      expect((error as DatabaseGenerationError).generation.kind).toBe('v1');
      expect((error as Error).message).toMatch(/Greenhouse 1\.x[\s\S]*3\.0\.2 first, then to 4\.0/);
      const booting = createDatabase(url);
      await expect(booting.initSchema()).rejects.toThrow(/3\.0\.2 first, then to 4\.0/);
      await booting.close();
    });
    await withDatabase('v2', async (url) => {
      await queryRows(url, 'CREATE TABLE members (id serial PRIMARY KEY)');
      const error = await applyAllMigrations(url).catch((err: unknown) => err);
      expect((error as DatabaseGenerationError).generation.kind).toBe('v2');
      expect((error as Error).message).toMatch(/Greenhouse 2\.x[\s\S]*no release upgrades 2\.x: start a fresh install/);
    });
    await withDatabase('half', async (url) => {
      await buildV3Database(url);
      await queryRows(
        url,
        'CREATE TABLE drizzle.greenhouse_carry (id integer PRIMARY KEY, source_version text, started_at timestamptz NOT NULL, completed_at timestamptz);' +
          "INSERT INTO drizzle.greenhouse_carry VALUES (1, '0013_report_templates', now(), NULL)",
      );
      const error = await applyAllMigrations(url).catch((err: unknown) => err);
      expect((error as DatabaseGenerationError).generation.kind).toBe('carry_incomplete');
      expect(await queryRows(url, 'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).toEqual([{ n: 3 }]);
    });
  }, 60_000);
});
