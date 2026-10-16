import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { transaction } from './client.js';
import { extensionMigrations } from './schema/extensions.js';

export interface ExtensionMigrationSource {
  extensionId: string;
  dir: string;
}

/** Append-only SQL, atomic under the same advisory lock on every replica. */
export async function applyExtensionMigrations(sources: readonly ExtensionMigrationSource[]): Promise<string[]> {
  if (!sources.length) return [];
  return transaction(async (db) => {
    await db.execute(sql`select pg_advisory_xact_lock(74192026)`);
    const applied: string[] = [];
    for (const source of sources) {
      const files = readdirSync(source.dir)
        .filter((name) => name.endsWith('.sql'))
        .sort();
      if (files.some((name) => !/^\d+_[a-z0-9_-]+\.sql$/.test(name)))
        throw new Error(`Invalid extension migration filename: ${source.extensionId}`);
      const previous = await db
        .select()
        .from(extensionMigrations)
        .where(eq(extensionMigrations.extensionId, source.extensionId));
      for (const row of previous)
        if (!files.includes(row.name))
          throw new Error(`Missing extension migration: ${source.extensionId}/${row.name}`);
      for (const name of files) {
        const body = readFileSync(join(source.dir, name), 'utf8');
        const checksum = createHash('sha256').update(body).digest('hex');
        const old = previous.find((row) => row.name === name);
        if (old) {
          if (old.checksum !== checksum) throw new Error(`Extension migration changed: ${source.extensionId}/${name}`);
          continue;
        }
        if (previous.some((row) => row.name > name))
          throw new Error(`Extension migrations must append: ${source.extensionId}/${name}`);
        for (const statement of body
          .split('--> statement-breakpoint')
          .map((part) => part.trim())
          .filter(Boolean))
          await db.execute(sql.raw(statement));
        await db.insert(extensionMigrations).values({ extensionId: source.extensionId, name, checksum });
        applied.push(`${source.extensionId}/${name}`);
      }
    }
    return applied;
  });
}
