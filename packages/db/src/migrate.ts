/**
 * Applying the 3.0 baseline and later migrations, and telling which Greenhouse
 * generation a database belongs to.
 *
 * 3.0 starts from a fresh baseline (`drizzle/0000_v3_baseline.sql`); the 1.x
 * chain (0000–0013) is archived in `drizzle/archive-1x/` and only used here to
 * recognize a 1.x database. A 1.x database is never migrated in place: the
 * operator creates a new database and runs `pnpm cli migrate-from-1x`. A v2
 * database (the parallel 2.x line, `members` instead of `users`) is refused.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { readCoreMigrations } from './core-migrations.js';

const MIGRATION_LOCK_KEY = 74_192_031;

/** `drizzle/` at the repository root. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url));
/** The archived 1.x chain, kept for version detection only. */
export const V1_ARCHIVE_FOLDER = join(MIGRATIONS_FOLDER, 'archive-1x');
/** The last 1.x migration a database must have before it can be carried. */
export const V1_LATEST_TAG = '0013_report_templates';

export type DatabaseGeneration =
  | { kind: 'empty' }
  | { kind: 'v3'; applied: string[] }
  | { kind: 'v1'; applied: string[]; latest: string | null; current: boolean }
  | { kind: 'v2' }
  | { kind: 'unknown'; tables: number };

export class DatabaseGenerationError extends Error {
  constructor(
    message: string,
    readonly generation: DatabaseGeneration,
  ) {
    super(message);
    this.name = 'DatabaseGenerationError';
  }
}

async function appliedHashes(sql: postgres.Sql): Promise<Set<string>> {
  const [exists] = await sql<{ t: string | null }[]>`SELECT to_regclass('drizzle.__drizzle_migrations')::text AS t`;
  if (!exists?.t) return new Set();
  const rows = await sql<{ hash: string }[]>`SELECT hash FROM drizzle.__drizzle_migrations`;
  return new Set(rows.map((row) => row.hash));
}

/** Inspect a database without changing it. */
export async function detectDatabaseGeneration(
  sql: postgres.Sql,
  folders: { current?: string; archive?: string } = {},
): Promise<DatabaseGeneration> {
  const [row] = await sql<
    { users: string | null; members: string | null; sessions: string | null; conversations: string | null; n: number }[]
  >`
    SELECT to_regclass('public.users')::text AS users,
           to_regclass('public.members')::text AS members,
           to_regclass('public.sessions')::text AS sessions,
           to_regclass('public.conversations')::text AS conversations,
           (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public') AS n`;
  if (row?.members && !row.users) return { kind: 'v2' };

  const hashes = await appliedHashes(sql);
  const currentFolder = folders.current ?? MIGRATIONS_FOLDER;
  const archiveFolder = folders.archive ?? V1_ARCHIVE_FOLDER;
  const v3Applied = existsSync(join(currentFolder, 'meta', '_journal.json'))
    ? readCoreMigrations(currentFolder)
        .filter((file) => hashes.has(file.hash))
        .map((file) => file.tag)
    : [];
  const v1Chain = existsSync(join(archiveFolder, 'meta', '_journal.json')) ? readCoreMigrations(archiveFolder) : [];
  const v1Applied = v1Chain.filter((file) => hashes.has(file.hash)).map((file) => file.tag);

  if (row?.users && row.sessions && !row.conversations) {
    const latest = v1Applied.at(-1) ?? null;
    return { kind: 'v1', applied: v1Applied, latest, current: latest === V1_LATEST_TAG };
  }
  if (v1Applied.length > 0 && v3Applied.length === 0) {
    const latest = v1Applied.at(-1) ?? null;
    return { kind: 'v1', applied: v1Applied, latest, current: latest === V1_LATEST_TAG };
  }
  if (row?.users && row.conversations) return { kind: 'v3', applied: v3Applied };
  if (v3Applied.length > 0) return { kind: 'v3', applied: v3Applied };
  if (!row?.users && (row?.n ?? 0) === 0) return { kind: 'empty' };
  // Tables but none of ours (extension tables alone, or another product).
  return { kind: 'unknown', tables: row?.n ?? 0 };
}

/** Why `migrate` (and the API boot) refuse this generation; null when they may proceed. */
export function refusalFor(generation: DatabaseGeneration): string | null {
  switch (generation.kind) {
    case 'v1':
      return (
        'This database belongs to Greenhouse 1.x' +
        (generation.latest ? ` (migrations through ${generation.latest})` : '') +
        '. 3.0 never upgrades a 1.x database in place: create a new, empty database and run\n' +
        '  pnpm cli migrate-from-1x --from <this database url> --to <new database url>\n' +
        'then point DATABASE_URL at the new database. The 1.x database is left untouched.'
      );
    case 'v2':
      return (
        'This database belongs to Greenhouse 2.x (it has `members`, not `users`). ' +
        '3.0 cannot run on it or carry it; keep it on the 2.x line.'
      );
    case 'unknown':
      return (
        `This database already has ${generation.tables} table(s) but no Greenhouse schema. ` +
        'Point DATABASE_URL at an empty database (or a 3.0 one).'
      );
    default:
      return null;
  }
}

/** Throw a DatabaseGenerationError unless the database is empty or already 3.0. */
export async function assertMigratableDatabase(sql: postgres.Sql): Promise<DatabaseGeneration> {
  const generation = await detectDatabaseGeneration(sql);
  const refusal = refusalFor(generation);
  if (refusal) throw new DatabaseGenerationError(refusal, generation);
  return generation;
}

/**
 * Apply the 3.0 chain to an empty or 3.0 database (the same journal
 * `drizzle-kit migrate` uses), under an advisory lock so replicas that boot
 * together apply it once. Refuses 1.x, 2.x and foreign databases.
 */
export async function applyMigrations(url: string, folder = MIGRATIONS_FOLDER): Promise<DatabaseGeneration> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`;
    try {
      const generation = await assertMigratableDatabase(sql);
      await migrate(drizzle(sql), { migrationsFolder: folder });
      return generation;
    } finally {
      await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`.catch(() => undefined);
    }
  } finally {
    await sql.end();
  }
}
