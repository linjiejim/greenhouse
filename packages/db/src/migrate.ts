/**
 * Applying the 4.0 core chain, upgrading a 3.x database in place, and telling
 * which Greenhouse generation a database belongs to.
 *
 * 4.0 starts from a fresh baseline (`migrations/0000_v4_baseline.sql`, the 49
 * core tables). The 3.x chain (0000_v3_baseline … 0009) is archived in
 * `migrations/archive-3x/`: a database that carries any prefix of it is bridged
 * in place — the archived chain is finished, then the 4.0 baseline is recorded
 * as applied without running it (the schema is already there). The bridge never
 * drops tables or data; plugin tables the 3.x baseline created stay where they
 * are for their plugin lanes to adopt. 1.x and 2.x databases are refused: they
 * upgrade to 3.0.2 first, then to 4.0.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { MIGRATIONS_FOLDER, readCoreMigrations } from './core-migrations.js';
import { readCarryState } from './carry-state.js';
import { createExtensionMigrationRunner, type ExtensionMigrationSource } from './extension-migrations.js';
import * as schema from './schema/index.js';

const MIGRATION_LOCK_KEY = 74_192_031;

export { MIGRATIONS_FOLDER };
/** The archived 3.x chain: finished by the bridge, never edited. */
export const V3_ARCHIVE_FOLDER = join(MIGRATIONS_FOLDER, 'archive-3x');

/**
 * Statements that take a database from the end of the archived 3.x chain to the
 * 4.0 baseline. Empty: the baseline was generated from the schema the archived
 * chain ends at, and the schema-equivalence test keeps the two in step. Anything
 * added here must be idempotent and must never drop a table or data.
 */
const V3_TO_V4_DELTA: readonly string[] = [];

export type DatabaseGeneration =
  | { kind: 'empty' }
  /** On the 4.0 chain. */
  | { kind: 'v4'; applied: string[] }
  /** On the archived 3.x chain (`applied` = its recorded tags); `pnpm db:migrate` bridges it in place. */
  | { kind: 'v3'; applied: string[] }
  /** Greenhouse tables, but no migration record either chain recognizes. */
  | { kind: 'unrecorded' }
  /** A database a 3.x `migrate-from-1x` run started filling and never finished. */
  | { kind: 'carry_incomplete'; startedAt: string }
  | { kind: 'v1' }
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

export { CARRY_MARKER_TABLE, readCarryState, readCarryStateFromDb } from './carry-state.js';
export type { CarryState } from './carry-state.js';

const UPGRADE_VIA_3 = 'Upgrade it to Greenhouse 3.0.2 first, then to 4.0.';

async function appliedHashes(sql: postgres.Sql): Promise<Set<string>> {
  const [exists] = await sql<{ t: string | null }[]>`SELECT to_regclass('drizzle.__drizzle_migrations')::text AS t`;
  if (!exists?.t) return new Set();
  const rows = await sql<{ hash: string }[]>`SELECT hash FROM drizzle.__drizzle_migrations`;
  return new Set(rows.map((row) => row.hash));
}

function recordedTags(folder: string, hashes: ReadonlySet<string>): string[] {
  if (!existsSync(join(folder, 'meta', '_journal.json'))) return [];
  return readCoreMigrations(folder)
    .filter((file) => hashes.has(file.hash))
    .map((file) => file.tag);
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
  if (row?.users && row.sessions && !row.conversations) return { kind: 'v1' };

  const hashes = await appliedHashes(sql);
  const v4Applied = recordedTags(folders.current ?? MIGRATIONS_FOLDER, hashes);
  const v3Applied = recordedTags(folders.archive ?? V3_ARCHIVE_FOLDER, hashes);
  if ((row?.users && row.conversations) || v4Applied.length > 0 || v3Applied.length > 0) {
    const carry = await readCarryState(sql);
    if (carry && !carry.completedAt) return { kind: 'carry_incomplete', startedAt: carry.startedAt };
    if (v4Applied.length > 0) return { kind: 'v4', applied: v4Applied };
    if (v3Applied.length > 0) return { kind: 'v3', applied: v3Applied };
    return { kind: 'unrecorded' };
  }
  if (!row?.users && (row?.n ?? 0) === 0) return { kind: 'empty' };
  // Tables but none of ours (extension tables alone, or another product).
  return { kind: 'unknown', tables: row?.n ?? 0 };
}

/** Open a connection, detect the generation, close it. */
export async function detectDatabaseGenerationAt(url: string): Promise<DatabaseGeneration> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return await detectDatabaseGeneration(sql);
  } finally {
    await sql.end();
  }
}

/** Why `migrate` (and the API boot) refuse this generation; null when they may proceed. */
export function refusalFor(generation: DatabaseGeneration): string | null {
  switch (generation.kind) {
    case 'v1':
      return (
        'This database belongs to Greenhouse 1.x. 4.0 upgrades only 3.x databases in place. ' +
        `${UPGRADE_VIA_3} The 1.x database is left untouched.`
      );
    case 'v2':
      return (
        'This database belongs to Greenhouse 2.x (it has `members`, not `users`). ' +
        `4.0 upgrades only 3.x databases in place. ${UPGRADE_VIA_3}`
      );
    case 'carry_incomplete':
      return (
        `A migrate-from-1x carry into this database started at ${generation.startedAt} and did not complete, ` +
        'so it holds only part of the data. Finish it with Greenhouse 3.0.2 (re-run its migrate-from-1x), ' +
        'then upgrade to 4.0 — or point DATABASE_URL elsewhere.'
      );
    case 'unrecorded':
      return (
        'This database has Greenhouse tables but no migration history this version recognizes ' +
        '(drizzle.__drizzle_migrations is missing or foreign). Restore it together with its `drizzle` schema; ' +
        'a database already on the 4.0 schema can record the chain with `pnpm cli db baseline --dry-run`.'
      );
    case 'unknown':
      return (
        `This database already has ${generation.tables} table(s) but no Greenhouse schema. ` +
        'Point DATABASE_URL at an empty database (or a 3.x / 4.0 one).'
      );
    default:
      return null;
  }
}

/** What the API boot says about a 3.x database `pnpm db:migrate` has not bridged yet. */
export const V3_AWAITING_BRIDGE =
  'This database is still on the Greenhouse 3.x schema. Run `pnpm db:migrate` first: ' +
  'it upgrades a 3.x database to 4.0 in place.';

let chainHashes: { current: Set<string>; archived: Set<string> } | null = null;

/**
 * Whether recorded migration hashes are 3.x-only: some archived 3.x entry is
 * recorded and no 4.0 entry is (the boot refuses such a database).
 */
export function awaitingV4Bridge(recorded: ReadonlySet<string>): boolean {
  chainHashes ??= {
    current: new Set(readCoreMigrations(MIGRATIONS_FOLDER).map((file) => file.hash)),
    archived: new Set(readCoreMigrations(V3_ARCHIVE_FOLDER).map((file) => file.hash)),
  };
  const { current, archived } = chainHashes;
  return [...recorded].some((hash) => archived.has(hash)) && ![...recorded].some((hash) => current.has(hash));
}

/** Throw a DatabaseGenerationError unless the database is empty, 3.x or 4.0. */
export async function assertMigratableDatabase(
  sql: postgres.Sql,
  folders: { current?: string; archive?: string } = {},
): Promise<DatabaseGeneration> {
  const generation = await detectDatabaseGeneration(sql, folders);
  const refusal = refusalFor(generation);
  if (refusal) throw new DatabaseGenerationError(refusal, generation);
  return generation;
}

/**
 * The in-place 3.x → 4.0 bridge, in one transaction: run the archived entries
 * newer than the database's last recorded one (drizzle's own rule, statements
 * and journal rows byte-identical to what drizzle writes), apply the delta, and
 * record the 4.0 baseline as applied. Touches nothing else — no table is
 * dropped, plugin tables and `extension_migrations` rows (including private
 * overlay lanes) stay as they are, and `drizzle.greenhouse_carry` is left alone.
 * Returns the archived tags it ran.
 */
async function bridgeFrom3x(sql: postgres.Sql, currentFolder: string, archiveFolder: string): Promise<string[]> {
  const archived = readMigrationFiles({ migrationsFolder: archiveFolder });
  const tags = readCoreMigrations(archiveFolder).map((file) => file.tag);
  const baseline = readCoreMigrations(currentFolder)[0];
  if (!baseline) throw new Error(`No 4.0 baseline in ${currentFolder}`);
  const lastArchived = archived.at(-1);
  if (lastArchived && baseline.folderMillis <= lastArchived.folderMillis) {
    throw new Error('The 4.0 baseline must be journaled after the last archived 3.x migration');
  }
  const finished: string[] = [];
  await sql.begin(async (tx) => {
    const [last] = await tx<{ created_at: string | null }[]>`
      SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`;
    const lastMillis = Number(last?.created_at ?? 0);
    for (const [index, migration] of archived.entries()) {
      if (migration.folderMillis <= lastMillis) continue;
      for (const statement of migration.sql) await tx.unsafe(statement);
      await tx`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${migration.hash}, ${migration.folderMillis})`;
      finished.push(tags[index] ?? String(index));
    }
    for (const statement of V3_TO_V4_DELTA) await tx.unsafe(statement);
    await tx`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${baseline.hash}, ${baseline.folderMillis})`;
  });
  return finished;
}

/**
 * Apply the 4.0 chain to an empty, 3.x or 4.0 database (the same journal
 * `drizzle-kit migrate` uses), under an advisory lock so replicas that boot
 * together apply it once. Refuses 1.x, 2.x and foreign databases.
 */
export async function applyMigrations(url: string, folder = MIGRATIONS_FOLDER): Promise<DatabaseGeneration> {
  return (await applyAllMigrations(url, { folder })).generation;
}

export interface AppliedMigrations {
  /** What the database was before this run. */
  generation: DatabaseGeneration;
  /** Archived 3.x tags the bridge ran before recording the 4.0 baseline (`null` = no bridge). */
  bridged: { archived: string[] } | null;
  /** The extension lane, when sources were given (`null` otherwise). */
  extensions: { applied: string[]; skipped: string[] } | null;
}

/**
 * `pnpm db:migrate`: under one advisory lock — the 3.x bridge when the database
 * carries the archived chain, the core chain, then the extension lane for the
 * given sources, so a deployment can migrate fully before it switches traffic.
 * The API boot still runs the extension lane (idempotent), which covers a
 * deployment that skips this step.
 */
export async function applyAllMigrations(
  url: string,
  opts: { folder?: string; archiveFolder?: string; extensionSources?: readonly ExtensionMigrationSource[] } = {},
): Promise<AppliedMigrations> {
  const folder = opts.folder ?? MIGRATIONS_FOLDER;
  const archiveFolder = opts.archiveFolder ?? V3_ARCHIVE_FOLDER;
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`;
    try {
      const generation = await assertMigratableDatabase(sql, { current: folder, archive: archiveFolder });
      const bridged = generation.kind === 'v3' ? { archived: await bridgeFrom3x(sql, folder, archiveFolder) } : null;
      const db = drizzle(sql, { schema });
      await migrate(db, { migrationsFolder: folder });
      const extensions = opts.extensionSources
        ? await createExtensionMigrationRunner(db).apply(opts.extensionSources)
        : null;
      return { generation, bridged, extensions };
    } finally {
      await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`.catch(() => undefined);
    }
  } finally {
    await sql.end();
  }
}
