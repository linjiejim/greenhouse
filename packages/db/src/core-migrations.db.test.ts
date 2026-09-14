/**
 * The core-migration baseline: adopting a database that already has the schema.
 *
 * The rows must be byte-identical to what `drizzle-kit migrate` would have
 * written, or a later real migrate run would replay the whole chain against
 * existing tables — which is the failure this command exists to prevent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { initDatabase, readCoreMigrations, _resetProvider, type DatabaseProvider } from './index.js';
import { TEST_DATABASE_URL } from './test-config.js';

const DRIZZLE_DIR = resolve(import.meta.dirname, '..', '..', '..', 'drizzle');
let db: DatabaseProvider;

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
});

afterEach(async () => {
  await db.close();
  _resetProvider();
});

describe('core migration baseline', () => {
  it('reads the chain exactly as drizzle does', () => {
    const ours = readCoreMigrations(DRIZZLE_DIR);
    const theirs = readMigrationFiles({ migrationsFolder: DRIZZLE_DIR });
    expect(ours.length).toBeGreaterThan(0);
    expect(ours.map((m) => m.hash)).toEqual(theirs.map((m) => m.hash));
    expect(ours.map((m) => m.folderMillis)).toEqual(theirs.map((m) => m.folderMillis));
  });

  it('records the whole chain as applied, once', async () => {
    const chain = readCoreMigrations(DRIZZLE_DIR);
    // The test database is already migrated; start from an unrecorded one.
    await db.executeRaw(sql`DELETE FROM drizzle.__drizzle_migrations`);

    expect((await db.coreMigrationBaseline.status(chain)).every((entry) => !entry.recorded)).toBe(true);

    const first = await db.coreMigrationBaseline.apply(chain);
    expect(first.recorded).toEqual(chain.map((m) => m.tag));
    expect((await db.coreMigrationBaseline.status(chain)).every((entry) => entry.recorded)).toBe(true);

    // Idempotent: adopting twice writes nothing the second time.
    expect((await db.coreMigrationBaseline.apply(chain)).recorded).toEqual([]);

    const rows = (await db.executeRaw(
      sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`,
    )) as Array<{ hash: string; created_at: string | number }>;
    expect(rows.map((r) => r.hash)).toEqual(chain.map((m) => m.hash));
    expect(rows.map((r) => Number(r.created_at))).toEqual(chain.map((m) => m.folderMillis));
  });
});
