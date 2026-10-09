/**
 * Core migration bookkeeping — reading, seeding and (for `MIGRATE_ON_START`)
 * applying drizzle's own journal.
 *
 * `drizzle-kit migrate` records every applied file in `drizzle.__drizzle_migrations`
 * and skips anything whose journal timestamp is not newer than the last row. An
 * existing database that already has the schema (an instance adopting this
 * codebase, a restored dump) therefore needs those rows written once — without
 * executing the SQL, which would fail against tables that already exist.
 *
 * The hash matches drizzle's own (`sha256` of the raw file), so a later real
 * `migrate` run sees exactly what it would have written itself.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Db } from './client.js';

/** Arbitrary but fixed, and distinct from the extension lane's key. */
const CORE_MIGRATION_LOCK_KEY = 74_192_027;

async function countRecorded(client: postgres.Sql): Promise<number> {
  const [table] = await client`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`;
  if (!table?.present) return 0;
  const [row] = await client`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
  return Number(row?.n ?? 0);
}

/**
 * Apply the pending core migrations from inside a process — the API's
 * `MIGRATE_ON_START` path, for hosts that cannot run compose's one-shot
 * `migrate` service (a Railway template, a single container).
 *
 * This is `drizzle-kit migrate` plus a lock: drizzle's own migrator, so the same
 * journal table and the same "newer than the last row" rule — the two paths are
 * interchangeable on one database. A dedicated single-connection client holds a
 * session advisory lock for the whole run, so replicas booting together apply
 * the chain once: the others wait, then find nothing pending. A dropped
 * connection releases the lock with it.
 */
export async function applyCoreMigrations(
  connectionString: string,
  migrationsFolder: string,
): Promise<{ applied: number }> {
  const client = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    await client`SELECT pg_advisory_lock(${CORE_MIGRATION_LOCK_KEY}::bigint)`;
    try {
      const before = await countRecorded(client);
      await migrate(drizzle(client), { migrationsFolder });
      return { applied: (await countRecorded(client)) - before };
    } finally {
      // Closing the session below releases it anyway; never mask a migration error.
      await client`SELECT pg_advisory_unlock(${CORE_MIGRATION_LOCK_KEY}::bigint)`.catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}

export interface CoreMigrationFile {
  tag: string;
  hash: string;
  /** Journal `when`, stored verbatim as `created_at` — what drizzle compares. */
  folderMillis: number;
  /** Tables this file creates — what `db baseline` checks really exist. */
  createsTables: string[];
  /** Tables this file drops, so a later drop cancels an earlier create. */
  dropsTables: string[];
}

/**
 * Table names a migration creates and drops.
 *
 * Deliberately a regex over the SQL rather than a parse: it only has to be
 * right about `CREATE TABLE` / `DROP TABLE` in files drizzle-kit generated, and
 * it is used to warn an operator, never to decide what runs. Callers net the
 * two across the chain — a table created in 0003 and dropped in 0006 is not
 * something a database in step with 0006 should still have.
 */
export function tablesTouchedBy(sqlText: string): { creates: string[]; drops: string[] } {
  const collect = (pattern: RegExp): string[] => {
    const names: string[] = [];
    for (const match of sqlText.matchAll(pattern)) if (match[1]) names.push(match[1]);
    return names;
  };
  return {
    creates: collect(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi),
    drops: collect(/DROP TABLE\s+(?:IF EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi),
  };
}

interface JournalEntry {
  tag: string;
  when: number;
}

/** The migration chain as drizzle reads it, in journal order. */
export function readCoreMigrations(migrationsFolder: string): CoreMigrationFile[] {
  const journalPath = join(migrationsFolder, 'meta', '_journal.json');
  if (!existsSync(journalPath)) throw new Error(`No migration journal at ${journalPath}`);
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries?: JournalEntry[] };
  return (journal.entries ?? []).map((entry) => {
    const file = join(migrationsFolder, `${entry.tag}.sql`);
    if (!existsSync(file)) throw new Error(`Journal lists ${entry.tag} but ${file} is missing`);
    const text = readFileSync(file, 'utf8');
    const touched = tablesTouchedBy(text);
    return {
      tag: entry.tag,
      hash: createHash('sha256').update(text).digest('hex'),
      folderMillis: entry.when,
      createsTables: touched.creates,
      dropsTables: touched.drops,
    };
  });
}

export function createCoreMigrationBaseline(db: Db) {
  async function ensureTable(): Promise<void> {
    await db.execute(sql.raw('CREATE SCHEMA IF NOT EXISTS drizzle'));
    await db.execute(
      sql.raw(
        'CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)',
      ),
    );
  }

  return {
    /** Which chain entries are already recorded, matched by hash. */
    async status(
      migrations: readonly CoreMigrationFile[],
    ): Promise<{ tag: string; recorded: boolean; createsTables: string[]; dropsTables: string[] }[]> {
      await ensureTable();
      const rows = (await db.execute(sql`SELECT hash FROM drizzle.__drizzle_migrations`)) as unknown as Array<{
        hash: string;
      }>;
      const known = new Set(rows.map((r) => r.hash));
      return migrations.map((m) => ({
        tag: m.tag,
        recorded: known.has(m.hash),
        createsTables: m.createsTables,
        dropsTables: m.dropsTables,
      }));
    },

    /** Record the missing entries without executing their SQL. */
    async apply(migrations: readonly CoreMigrationFile[]): Promise<{ recorded: string[] }> {
      await ensureTable();
      const state = await this.status(migrations);
      const pending = migrations.filter((m, i) => !state[i].recorded);
      const recorded: string[] = [];
      for (const m of pending) {
        await db.execute(
          sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${m.hash}, ${m.folderMillis})`,
        );
        recorded.push(m.tag);
      }
      return { recorded };
    },
  };
}
