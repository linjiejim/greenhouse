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
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

export interface ExtensionMigrationSource {
  extensionId: string;
  /** Absolute directory holding `NNNN_name.sql` files. */
  dir: string;
}

export interface ExtensionMigrationStatus {
  extensionId: string;
  name: string;
  applied: boolean;
  /** The file changed after it was applied — the runner refuses to continue. */
  drifted: boolean;
}

const TABLE = 'extension_migrations';
const STATEMENT_BREAKPOINT = '--> statement-breakpoint';
/** Arbitrary but fixed: every runner instance serializes on the same key. */
const ADVISORY_LOCK_KEY = 74_192_026;

interface MigrationFile {
  name: string;
  checksum: string;
  statements: string[];
}

function readMigrationFiles(dir: string): MigrationFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const text = readFileSync(join(dir, name), 'utf8');
      return {
        name,
        checksum: createHash('sha256').update(text).digest('hex'),
        statements: text
          .split(STATEMENT_BREAKPOINT)
          .map((s) => s.trim())
          .filter(Boolean),
      };
    });
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
    /** What is applied / pending / drifted per source, without changing anything. */
    async status(sources: readonly ExtensionMigrationSource[]): Promise<ExtensionMigrationStatus[]> {
      await ensureTable();
      const out: ExtensionMigrationStatus[] = [];
      for (const source of sources) {
        const applied = await appliedChecksums(db, source.extensionId);
        for (const file of readMigrationFiles(source.dir)) {
          const existing = applied.get(file.name);
          out.push({
            extensionId: source.extensionId,
            name: file.name,
            applied: existing !== undefined,
            drifted: existing !== undefined && existing !== file.checksum,
          });
        }
      }
      return out;
    },

    /** Apply every pending file of every source, in order, atomically. */
    async apply(sources: readonly ExtensionMigrationSource[]): Promise<{ applied: string[] }> {
      if (sources.length === 0) return { applied: [] };
      await ensureTable();
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`);
        const applied: string[] = [];
        for (const source of sources) {
          const existing = await appliedChecksums(tx as unknown as Db, source.extensionId);
          for (const file of readMigrationFiles(source.dir)) {
            const checksum = existing.get(file.name);
            if (checksum !== undefined) {
              if (checksum !== file.checksum) {
                throw new Error(
                  `Extension migration ${source.extensionId}/${file.name} changed after it was applied — ` +
                    'add a new migration file instead of editing an applied one',
                );
              }
              continue;
            }
            for (const statement of file.statements) await tx.execute(sql.raw(statement));
            await tx.execute(
              sql`INSERT INTO extension_migrations (extension_id, name, checksum) VALUES (${source.extensionId}, ${file.name}, ${file.checksum})`,
            );
            applied.push(`${source.extensionId}/${file.name}`);
          }
        }
        return { applied };
      });
    },
  };
}

export type ExtensionMigrationRunner = ReturnType<typeof createExtensionMigrationRunner>;
