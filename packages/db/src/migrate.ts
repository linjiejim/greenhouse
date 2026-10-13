/**
 * Applying the v2 baseline and later migrations. The same drizzle journal as
 * `drizzle-kit migrate`, run under an advisory lock so replicas that boot together
 * apply it once. A database that still carries the v1 migration chain is refused:
 * v2 starts from an empty database (docs/product/migration-v1.md).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const MIGRATION_LOCK_KEY = 74_192_028;

/** drizzle/ at the repository root. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url));

function firstJournalTag(folder: string): string | null {
  const journal = join(folder, 'meta', '_journal.json');
  if (!existsSync(journal)) return null;
  const entries = (JSON.parse(readFileSync(journal, 'utf8')) as { entries?: { tag: string }[] }).entries ?? [];
  return entries[0]?.tag ?? null;
}

/** Throws when the database was built by v1 (its tables exist without the v2 baseline). */
export async function assertNotV1Database(sql: postgres.Sql): Promise<void> {
  const [row] = await sql<{ users: string | null; members: string | null }[]>`
    SELECT to_regclass('public.users')::text AS users, to_regclass('public.members')::text AS members`;
  if (row?.users && !row.members) {
    throw new Error(
      'This database holds Greenhouse v1 data. v2 starts from an empty database; ' +
        'move v1 data with the migration tool described in docs/product/migration-v1.md.',
    );
  }
}

export async function applyMigrations(url: string, folder = MIGRATIONS_FOLDER): Promise<void> {
  if (!firstJournalTag(folder)) throw new Error(`No migration journal in ${folder}`);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`;
    try {
      await assertNotV1Database(sql);
      await migrate(drizzle(sql), { migrationsFolder: folder });
    } finally {
      await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`.catch(() => undefined);
    }
  } finally {
    await sql.end();
  }
}
