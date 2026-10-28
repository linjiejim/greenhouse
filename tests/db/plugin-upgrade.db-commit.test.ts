/**
 * @db-commit-reason A real 3.0.2 database is upgraded in place and reopened across process/configuration changes.
 * Every official plugin table contains data; counts and full row fingerprints must survive.
 */
import { it, expect } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyAllMigrations } from '@greenhouse/db';
import {
  TEST_DATABASE_URL,
  buildV3Database,
  recreateDatabase,
  dropDatabase,
  queryRows,
} from '@greenhouse/db/test-config';
const root = resolve(import.meta.dirname, '../..');
it('upgrades populated 3.0 tables without data loss, including disable/re-enable of the document plugin', async () => {
  const name = `gh4_schema_plugin_upgrade_${randomBytes(4).toString('hex')}_test`;
  const url = await recreateDatabase(TEST_DATABASE_URL, name);
  try {
    // What a 3.0.2 install has: the archived 3.x chain through 0002.
    await buildV3Database(url);
    await queryRows(url, readFileSync(join(root, 'tests/fixtures/plugin-upgrade-v3.sql'), 'utf8'));
    const sources = readdirSync(join(root, 'plugins')).flatMap((id) => {
      const dir = join(root, 'plugins', id, 'migrations');
      return existsSync(join(dir, '0001_adopt.sql')) ? [{ extensionId: id, dir }] : [];
    });
    const tables = [
      ...new Set(
        sources.flatMap((source) =>
          [
            ...readFileSync(join(source.dir, '0001_adopt.sql'), 'utf8').matchAll(
              /CREATE TABLE IF NOT EXISTS "([a-z_]+)"/g,
            ),
          ].map((match) => match[1]),
        ),
      ),
    ].sort();
    expect(tables.length).toBe(24);
    const inventory = async () =>
      Object.fromEntries(
        await Promise.all(
          tables.map(async (table) => {
            const rows = await queryRows(
              url,
              `SELECT to_jsonb(t)::text AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`,
            );
            return [
              table,
              { count: rows.length, hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex') },
            ];
          }),
        ),
      );
    const before = await inventory();
    for (const [table, entry] of Object.entries(before)) expect(entry.count, table).toBeGreaterThan(0);
    const migrated = await applyAllMigrations(url, { extensionSources: sources });
    expect(migrated.generation.kind).toBe('v3');
    expect(migrated.bridged?.archived[0]).toBe('0003_w2a_plugin_ownership');
    expect(migrated.extensions?.applied).toContain('knowledge/0001_adopt.sql');
    expect(await inventory()).toEqual(before);
    // The same migration entrypoint used by CLI/boot receives only active lanes.
    await applyAllMigrations(url, { extensionSources: sources.filter((source) => source.extensionId !== 'knowledge') });
    expect(await inventory()).toEqual(before);
    await applyAllMigrations(url, { extensionSources: sources });
    expect(await inventory()).toEqual(before);
    expect(await queryRows(url, "SELECT content, folder_id FROM kb_documents WHERE id='upgrade-doc'")).toEqual([
      { content: 'Retained **Markdown**', folder_id: 'upgrade-folder' },
    ]);
  } finally {
    await dropDatabase(TEST_DATABASE_URL, name);
  }
}, 60_000);
