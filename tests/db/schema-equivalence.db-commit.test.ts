/**
 * @db-commit-reason Whole databases are built through the real migration entrypoint
 * (a fresh 4.0 install, 3.x installs bridged in place) and their catalogs compared.
 *
 * A fresh 4.0 database with every official plugin enabled must have exactly the
 * schema of a 3.x database upgraded in place, so later migrations meet one shape.
 * Columns compare by name: ordinal position is not schema.
 */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyAllMigrations, coreTableNames, readCoreMigrations, V3_ARCHIVE_FOLDER } from '@greenhouse/db';
import {
  TEST_DATABASE_URL,
  buildV3Database,
  dropDatabase,
  queryRows,
  recreateDatabase,
} from '@greenhouse/db/test-config';
import { diffSchemaCatalogs, readSchemaCatalog, type SchemaCatalog } from '../helpers/schema-catalog.js';

const root = resolve(import.meta.dirname, '../..');
const fixture = readFileSync(join(root, 'tests/fixtures/plugin-upgrade-v3.sql'), 'utf8');

/** Every official plugin lane (a plugin without migrations owns no tables). */
const officialSources = readdirSync(join(root, 'plugins'))
  .sort()
  .flatMap((id) => {
    const dir = join(root, 'plugins', id, 'migrations');
    return existsSync(dir) ? [{ extensionId: id, dir }] : [];
  });

/**
 * Documented differences between a fresh 4.0 database and an upgraded 3.x one.
 * None today: the 4.0 baseline was generated from the schema the archived chain
 * ends at, and each plugin lane re-declares the tables the 3.x baseline created.
 */
const INTENTIONAL_DIFFERENCES: string[] = [];

async function withDatabase<T>(label: string, run: (url: string) => Promise<T>): Promise<T> {
  const name = `gh4_schema_${label}_${randomBytes(4).toString('hex')}_test`;
  const url = await recreateDatabase(TEST_DATABASE_URL, name);
  try {
    return await run(url);
  } finally {
    await dropDatabase(TEST_DATABASE_URL, name);
  }
}

let fresh: SchemaCatalog | null = null;
async function freshWithPlugins(): Promise<SchemaCatalog> {
  fresh ??= await withDatabase('fresh', async (url) => {
    const result = await applyAllMigrations(url, { extensionSources: officialSources });
    expect(result.generation.kind).toBe('empty');
    expect(result.bridged).toBeNull();
    return readSchemaCatalog(url);
  });
  return fresh;
}

describe('4.0 schema equivalence', () => {
  it('a fresh 4.0 database with every plugin disabled has only the core tables', async () => {
    await withDatabase('core', async (url) => {
      await applyAllMigrations(url);
      const catalog = await readSchemaCatalog(url);
      expect(new Set(catalog.tables)).toEqual(coreTableNames());
      expect(catalog.tables).toHaveLength(49);
      // The comparison has teeth: enabling the plugins adds their 25 tables and nothing else.
      const plugins = await freshWithPlugins();
      const pluginTables = plugins.tables.filter((table) => !catalog.tables.includes(table));
      expect(pluginTables).toHaveLength(25);
      const diff = diffSchemaCatalogs(catalog, plugins);
      expect(diff.filter((line) => !pluginTables.some((table) => line.includes(` ${table}`)))).toEqual([]);
    });
  }, 60_000);

  it('a fresh 4.0 database with every plugin enabled matches a 3.0.2 database upgraded in place', async () => {
    const expected = await freshWithPlugins();
    await withDatabase('v302', async (url) => {
      await buildV3Database(url);
      await queryRows(url, fixture);
      const result = await applyAllMigrations(url, { extensionSources: officialSources });
      expect(result.generation).toEqual({
        kind: 'v3',
        applied: ['0000_v3_baseline', '0001_drop_workbench_prefs', '0002_mcp_connectors'],
      });
      expect(result.bridged?.archived).toEqual(
        readCoreMigrations(V3_ARCHIVE_FOLDER)
          .slice(3)
          .map((m) => m.tag),
      );
      expect(diffSchemaCatalogs(expected, await readSchemaCatalog(url))).toEqual(INTENTIONAL_DIFFERENCES);

      // Idempotent: a second run is an ordinary 4.0 migrate.
      const again = await applyAllMigrations(url, { extensionSources: officialSources });
      expect(again.generation.kind).toBe('v4');
      expect(again.bridged).toBeNull();
      expect(again.extensions).toEqual({ applied: [], skipped: [] });
    });
  }, 60_000);

  it('bridges every prefix of the archived 3.x chain to the same schema', async () => {
    const expected = await freshWithPlugins();
    for (const { tag } of readCoreMigrations(V3_ARCHIVE_FOLDER)) {
      await withDatabase('prefix', async (url) => {
        await buildV3Database(url, tag);
        const result = await applyAllMigrations(url, { extensionSources: officialSources });
        expect(result.generation.kind, tag).toBe('v3');
        expect(diffSchemaCatalogs(expected, await readSchemaCatalog(url)), tag).toEqual(INTENTIONAL_DIFFERENCES);
      });
    }
  }, 300_000);
});
