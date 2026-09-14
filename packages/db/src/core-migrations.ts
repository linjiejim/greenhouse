/**
 * Core migration bookkeeping — reading and seeding drizzle's own journal table.
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
import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

export interface CoreMigrationFile {
  tag: string;
  hash: string;
  /** Journal `when`, stored verbatim as `created_at` — what drizzle compares. */
  folderMillis: number;
  /** Tables this file creates — what `db baseline` checks really exist. */
  createsTables: string[];
}

/**
 * Table names a migration creates.
 *
 * Deliberately a regex over the SQL rather than a parse: it only has to be
 * right about `CREATE TABLE` in files drizzle-kit generated, and it is used to
 * warn an operator, never to decide what runs.
 */
export function tablesCreatedBy(sqlText: string): string[] {
  const names: string[] = [];
  const pattern = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;
  for (const match of sqlText.matchAll(pattern)) if (match[1]) names.push(match[1]);
  return names;
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
    return {
      tag: entry.tag,
      hash: createHash('sha256').update(text).digest('hex'),
      folderMillis: entry.when,
      createsTables: tablesCreatedBy(text),
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
    ): Promise<{ tag: string; recorded: boolean; createsTables: string[] }[]> {
      await ensureTable();
      const rows = (await db.execute(sql`SELECT hash FROM drizzle.__drizzle_migrations`)) as unknown as Array<{
        hash: string;
      }>;
      const known = new Set(rows.map((r) => r.hash));
      return migrations.map((m) => ({ tag: m.tag, recorded: known.has(m.hash), createsTables: m.createsTables }));
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
