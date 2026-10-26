/**
 * Migration lane for extensions.
 *
 * Core DDL stays in `drizzle/*.sql` (applied by `drizzle-kit migrate` before the
 * API starts). An extension ships its own ordered `*.sql` files instead of
 * editing the core chain; this runner applies the pending ones at boot, tracked
 * in `extension_migrations` (one row per extension + file, with a checksum so a
 * file edited after it was applied fails fast instead of silently diverging).
 *
 * Files use the same `--> statement-breakpoint` separator as drizzle-kit output,
 * so `drizzle-kit generate` against an extension's own schema works unchanged.
 * All pending files are applied inside one transaction under an advisory lock,
 * which keeps several API replicas booting at once from racing each other.
 *
 * Core generation marker. A file whose header carries
 * `-- greenhouse:core-generation 1x` was written against the 1.x core tables
 * (it alters or reads a 1.x table). 3.0 never executes such a file:
 *  - on a database that was never carried from 1.x it is recorded as satisfied
 *    and reported as skipped;
 *  - on a carried database whose copied bookkeeping has the row, nothing happens;
 *  - on a carried database where the extension ran on 1.x but this row is
 *    missing, 1.x never applied the file, so the lane refuses: run it on 1.x and
 *    carry again.
 * The marker line is not part of the checksum, so marking a file that is
 * already applied does not count as editing it.
 *
 * A file that is not marked 1x may not CREATE a table the core chain owns.
 */
import { createHash } from 'node:crypto';
import { coreTableNames, tablesTouchedBy } from './core-migrations.js';
import { readCarryStateFromDb } from './carry-state.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

export interface ExtensionMigrationSource {
  extensionId: string;
  /** Absolute directory holding `NNNN_name.sql` files. */
  dir: string;
}

/** The core generation a file was written against; `null` = the current one. */
export type ExtensionMigrationGeneration = '1x' | null;

/**
 * What the lane does / did with a file:
 *  - `applied`  — recorded (ran here, or was carried over / baselined);
 *  - `pending`  — will run on the next apply;
 *  - `skipped`  — a 1x file on a database never carried from 1.x: recorded as
 *                 satisfied without running (or will be on the next apply);
 *  - `missing`  — a 1x file on a carried database whose 1.x side never ran it:
 *                 the lane refuses until it is run on 1.x and carried again.
 */
export type ExtensionMigrationState = 'applied' | 'pending' | 'skipped' | 'missing';

export interface ExtensionMigrationStatus {
  extensionId: string;
  name: string;
  generation: ExtensionMigrationGeneration;
  state: ExtensionMigrationState;
  createsTables: string[];
  dropsTables: string[];
  applied: boolean;
  /** The file changed after it was applied — the runner refuses to continue. */
  drifted: boolean;
  /** Core tables this (current-generation) file would CREATE — the runner refuses it. */
  collidesWithCore: string[];
}

const TABLE = 'extension_migrations';
const STATEMENT_BREAKPOINT = '--> statement-breakpoint';
/** `-- greenhouse:core-generation 1x` on a line of its own (whitespace tolerant). */
const GENERATION_MARKER = /^[ \t]*--[ \t]*greenhouse:core-generation[ \t]+(\S+)[ \t]*(?:\r?\n|$)/gm;
/** Arbitrary but fixed: every runner instance serializes on the same key. */
const ADVISORY_LOCK_KEY = 74_192_026;

export interface MigrationFile {
  name: string;
  /** sha256 of the file with marker lines removed — byte-identical to the raw hash for unmarked files. */
  checksum: string;
  /** sha256 of the raw file, accepted too: a 1.x runner that saw the marker recorded this one. */
  rawChecksum: string;
  generation: ExtensionMigrationGeneration;
  /** Tables the file creates / drops — `db baseline` checks the net set exists. */
  createsTables: string[];
  dropsTables: string[];
  statements: string[];
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Parse one migration file's text: generation marker, checksums, touched tables, statements. */
export function parseMigrationFile(name: string, raw: string): MigrationFile {
  let generation: ExtensionMigrationGeneration = null;
  for (const match of raw.matchAll(GENERATION_MARKER)) {
    if (match[1] !== '1x') {
      throw new Error(`Extension migration ${name}: unknown core generation "${match[1]}" (only "1x" is defined)`);
    }
    generation = '1x';
  }
  const text = generation ? raw.replace(GENERATION_MARKER, '') : raw;
  const touched = tablesTouchedBy(text);
  return {
    name,
    checksum: sha256(text),
    rawChecksum: sha256(raw),
    generation,
    createsTables: touched.creates,
    dropsTables: touched.drops,
    statements: text
      .split(STATEMENT_BREAKPOINT)
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export function readMigrationFiles(dir: string): MigrationFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => parseMigrationFile(name, readFileSync(join(dir, name), 'utf8')));
}

/** Net tables owned by current-generation files plus explicitly registered test/reset tables. */
export function extensionMigrationTables(
  source: ExtensionMigrationSource,
  resetTables: readonly string[] = [],
): string[] {
  const tables = new Set(resetTables);
  for (const file of readMigrationFiles(source.dir)) {
    if (file.generation) continue;
    for (const table of file.createsTables) tables.add(table);
    for (const table of file.dropsTables) tables.delete(table);
  }
  const core = coreTableNames();
  for (const table of tables) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table) || core.has(table)) {
      throw new Error(`Refusing to drop protected or invalid table "${table}" for plugin "${source.extensionId}"`);
    }
  }
  return [...tables].sort();
}

const checksumMatches = (file: MigrationFile, recorded: string) =>
  recorded === file.checksum || recorded === file.rawChecksum;

/** Core tables a current-generation file would create (1x files never run, so never collide). */
function coreCollisions(file: MigrationFile, core: ReadonlySet<string>): string[] {
  if (file.generation) return [];
  return file.createsTables.filter((table) => core.has(table));
}

/**
 * Whether a database came from a completed 1.x carry. Only then can a 1x file
 * have been applied (on the 1.x side) — and only if the extension was there.
 */
async function carriedFrom1x(executor: Db): Promise<boolean> {
  const carry = await readCarryStateFromDb(executor);
  return Boolean(carry?.completedAt);
}

/**
 * What to do with an unrecorded 1x file. On a carried database where the
 * extension has rows (it ran on 1.x) a missing row means 1.x never applied the
 * file; an extension with no rows at all was first enabled after the carry, so
 * its 1x files are as irrelevant as on a fresh install.
 */
function unrecorded1xState(carried: boolean, extensionHasRows: boolean): 'skipped' | 'missing' {
  return carried && extensionHasRows ? 'missing' : 'skipped';
}

function missing1xError(extensionId: string, names: string[]): Error {
  return new Error(
    `Extension migration(s) ${names.map((n) => `${extensionId}/${n}`).join(', ')} target the 1.x core ` +
      '(-- greenhouse:core-generation 1x) and were never applied on the 1.x database this one was carried from. ' +
      '3.0 does not run 1.x migrations: apply them on the 1.x database, then run migrate-from-1x again.',
  );
}

function collisionError(extensionId: string, name: string, tables: string[]): Error {
  return new Error(
    `Extension migration ${extensionId}/${name} creates core table(s) ${tables.join(', ')} — ` +
      'an extension owns its own tables; rename them (e.g. with the extension id as a prefix).',
  );
}

export function createExtensionMigrationRunner(db: Db) {
  async function ensureTable(): Promise<void> {
    await db.execute(
      sql.raw(
        `CREATE TABLE IF NOT EXISTS ${TABLE} (` +
          'extension_id text NOT NULL, name text NOT NULL, checksum text NOT NULL, ' +
          'applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (extension_id, name))',
      ),
    );
  }

  async function appliedChecksums(executor: Db, extensionId: string): Promise<Map<string, string>> {
    const rows = (await executor.execute(
      sql`SELECT name, checksum FROM extension_migrations WHERE extension_id = ${extensionId}`,
    )) as unknown as Array<{ name: string; checksum: string }>;
    return new Map(rows.map((r) => [r.name, r.checksum]));
  }

  return {
    /** Serialize first installation across API replicas. Retry a failed hook without marking it installed. */
    async installOnce(extensionId: string, install: () => Promise<void>): Promise<boolean> {
      await ensureTable();
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`);
        const rows = await tx.execute(
          sql`SELECT 1 FROM extension_migrations WHERE extension_id = ${extensionId} AND name = '@onInstall'`,
        );
        if (rows.length) return false;
        await install();
        await tx.execute(
          sql`INSERT INTO extension_migrations (extension_id, name, checksum) VALUES (${extensionId}, '@onInstall', 'sdk2-install-v1')`,
        );
        return true;
      });
    },
    /** Operator-only uninstall. The host checks disabled state and confirmation before calling. */
    async drop(source: ExtensionMigrationSource, resetTables: readonly string[] = []): Promise<string[]> {
      const tables = extensionMigrationTables(source, resetTables);
      await ensureTable();
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`);
        // A single RESTRICT statement permits dependencies within this plugin, but
        // refuses dependencies from any other table. Never cascade into another lane.
        if (tables.length) {
          await tx.execute(
            sql`DROP TABLE IF EXISTS ${sql.join(
              tables.map((table) => sql`public.${sql.identifier(table)}`),
              sql`, `,
            )} RESTRICT`,
          );
        }
        await tx.execute(sql`DELETE FROM extension_migrations WHERE extension_id = ${source.extensionId}`);
        return tables;
      });
    },
    /** What is applied / pending / drifted per source, without changing anything. */
    async status(sources: readonly ExtensionMigrationSource[]): Promise<ExtensionMigrationStatus[]> {
      await ensureTable();
      const out: ExtensionMigrationStatus[] = [];
      if (sources.length === 0) return out;
      const carried = await carriedFrom1x(db);
      const core = coreTableNames();
      for (const source of sources) {
        const applied = await appliedChecksums(db, source.extensionId);
        for (const file of readMigrationFiles(source.dir)) {
          const existing = applied.get(file.name);
          const recorded = existing !== undefined;
          let state: ExtensionMigrationState;
          if (file.generation === '1x') {
            // Recorded on a fresh install = it was skipped; on a carried one = 1.x ran it.
            state = recorded ? (carried ? 'applied' : 'skipped') : unrecorded1xState(carried, applied.size > 0);
          } else state = recorded ? 'applied' : 'pending';
          out.push({
            extensionId: source.extensionId,
            name: file.name,
            generation: file.generation,
            state,
            createsTables: file.createsTables,
            dropsTables: file.dropsTables,
            applied: recorded,
            drifted: recorded && !checksumMatches(file, existing),
            collidesWithCore: coreCollisions(file, core),
          });
        }
      }
      return out;
    },

    /**
     * Mark every pending file as applied WITHOUT running it.
     *
     * For adopting a database whose tables already exist — an internal instance
     * moving onto the extension lane, or a restored dump. The files must match
     * what is really in the database; the runner cannot verify that, which is
     * why this is an explicit operator command (`pnpm cli db baseline`) rather
     * than something the boot path can decide on its own.
     */
    async baseline(
      sources: readonly ExtensionMigrationSource[],
      opts: {
        /**
         * Per extension, the last file the database already reflects. Later
         * files are left pending so they apply normally — the case where a
         * migration exists to bring an adopted database the rest of the way.
         */
        through?: Readonly<Record<string, string>>;
      } = {},
    ): Promise<{ recorded: string[] }> {
      if (sources.length === 0) return { recorded: [] };
      await ensureTable();
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`);
        const carried = await carriedFrom1x(tx as unknown as Db);
        const recorded: string[] = [];
        for (const source of sources) {
          const existing = await appliedChecksums(tx as unknown as Db, source.extensionId);
          const extensionHasRows = existing.size > 0;
          const limit = opts.through?.[source.extensionId];
          let past = false;
          for (const file of readMigrationFiles(source.dir)) {
            if (past) break;
            if (limit !== undefined && file.name === limit) past = true;
            if (existing.has(file.name)) continue;
            // A 1x file 1.x never ran stays unrecorded: baseline must not paper over it.
            if (file.generation === '1x' && unrecorded1xState(carried, extensionHasRows) === 'missing') continue;
            await tx.execute(
              sql`INSERT INTO extension_migrations (extension_id, name, checksum) VALUES (${source.extensionId}, ${file.name}, ${file.checksum})`,
            );
            recorded.push(`${source.extensionId}/${file.name}`);
          }
        }
        return { recorded };
      });
    },

    /**
     * Apply every pending file of every source, in order, atomically. 1x files
     * never run: they are recorded as satisfied (`skipped`) or refused (see the
     * header). Refuses a current-generation file that creates a core table.
     */
    async apply(sources: readonly ExtensionMigrationSource[]): Promise<{ applied: string[]; skipped: string[] }> {
      if (sources.length === 0) return { applied: [], skipped: [] };
      await ensureTable();
      const core = coreTableNames();
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`);
        const carried = await carriedFrom1x(tx as unknown as Db);
        const applied: string[] = [];
        const skipped: string[] = [];
        for (const source of sources) {
          const existing = await appliedChecksums(tx as unknown as Db, source.extensionId);
          const files = readMigrationFiles(source.dir);
          // Refuse before running anything: a collision or a 1x gap is a build / carry mistake.
          for (const file of files) {
            const clash = coreCollisions(file, core);
            if (clash.length > 0) throw collisionError(source.extensionId, file.name, clash);
          }
          const missing = files.filter(
            (file) =>
              file.generation === '1x' &&
              !existing.has(file.name) &&
              unrecorded1xState(carried, existing.size > 0) === 'missing',
          );
          if (missing.length > 0)
            throw missing1xError(
              source.extensionId,
              missing.map((file) => file.name),
            );
          for (const file of files) {
            const checksum = existing.get(file.name);
            if (checksum !== undefined) {
              if (!checksumMatches(file, checksum)) {
                throw new Error(
                  `Extension migration ${source.extensionId}/${file.name} changed after it was applied — ` +
                    'add a new migration file instead of editing an applied one',
                );
              }
              continue;
            }
            if (file.generation === '1x') {
              await tx.execute(
                sql`INSERT INTO extension_migrations (extension_id, name, checksum) VALUES (${source.extensionId}, ${file.name}, ${file.checksum})`,
              );
              skipped.push(`${source.extensionId}/${file.name}`);
              continue;
            }
            for (const statement of file.statements) await tx.execute(sql.raw(statement));
            await tx.execute(
              sql`INSERT INTO extension_migrations (extension_id, name, checksum) VALUES (${source.extensionId}, ${file.name}, ${file.checksum})`,
            );
            applied.push(`${source.extensionId}/${file.name}`);
          }
        }
        return { applied, skipped };
      });
    },
  };
}

export type ExtensionMigrationRunner = ReturnType<typeof createExtensionMigrationRunner>;
