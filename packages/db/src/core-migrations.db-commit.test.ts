/**
 * `applyCoreMigrations` — the API's MIGRATE_ON_START path — against a fresh
 * database: it must build the whole chain exactly as `drizzle-kit migrate` does,
 * apply it once when two processes boot together, and be a no-op afterwards.
 *
 * @db-commit-reason the subject is DDL on an empty database plus a session
 * advisory lock held across two independent connections; neither exists inside
 * the rollback-wrapped shared test database.
 */

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyCoreMigrations, readCoreMigrations } from './core-migrations.js';
import { assertSafeTestDatabase, TEST_DATABASE_URL } from './test-config.js';

const DRIZZLE_DIR = resolve(import.meta.dirname, '..', '..', '..', 'drizzle');

function databaseUrl(name: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

const baseName = decodeURIComponent(new URL(TEST_DATABASE_URL).pathname.replace(/^\/+/, ''));
const freshName = `${baseName}_migstart_${randomBytes(4).toString('hex')}`;
const freshUrl = databaseUrl(freshName);
let admin: postgres.Sql;

beforeAll(async () => {
  assertSafeTestDatabase(freshUrl);
  admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${freshName}"`);
});

afterAll(async () => {
  await admin.unsafe(`DROP DATABASE IF EXISTS "${freshName}" WITH (FORCE)`);
  await admin.end();
});

describe('applyCoreMigrations', () => {
  it('applies the whole chain once when two processes boot together, then nothing', async () => {
    const chain = readCoreMigrations(DRIZZLE_DIR);

    const [first, second] = await Promise.all([
      applyCoreMigrations(freshUrl, DRIZZLE_DIR),
      applyCoreMigrations(freshUrl, DRIZZLE_DIR),
    ]);
    expect([first.applied, second.applied].sort((a, b) => a - b)).toEqual([0, chain.length]);

    const check = postgres(freshUrl, { max: 1, onnotice: () => {} });
    try {
      const journal = await check`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id`;
      // Byte-identical to drizzle-kit's own rows, so either path can run next.
      expect(journal.map((row) => row.hash)).toEqual(chain.map((m) => m.hash));
      const [users] = await check`SELECT to_regclass('public.users') IS NOT NULL AS present`;
      expect(users?.present).toBe(true);
      const [locks] = await check`
        SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
      expect(locks?.n).toBe(0);
    } finally {
      await check.end();
    }

    expect(await applyCoreMigrations(freshUrl, DRIZZLE_DIR)).toEqual({ applied: 0 });
  }, 120_000);
});
