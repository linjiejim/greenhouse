/** The core table set is derived from the migration chain; it must cover the whole drizzle schema. */
import { describe, expect, it } from 'vitest';
import { is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from './schema/index.js';
import { coreTableNames, MIGRATIONS_FOLDER, readCoreMigrations, tablesTouchedBy } from './core-migrations.js';
import { V3_ARCHIVE_FOLDER } from './migrate.js';

/**
 * What 3.x installs recorded in drizzle.__drizzle_migrations. The bridge
 * recognizes a 3.x database by these hashes, so the archived files must never
 * change by a byte (3.0.x releases ship 0000–0002).
 */
const ARCHIVED_3X = [
  ['0000_v3_baseline', '073ac8a5f013854606d9eb5285b063f7ba76aea71bbaff78cf8519f4637d7b97', 1792865494133],
  ['0001_drop_workbench_prefs', '1d8aefa6aab4da01e0f10fd3998bf349a8e300eefb744580d1c18c2918715505', 1792946180416],
  ['0002_mcp_connectors', '231fd88c333cd35cacdb7210fdfa8bfb298091a309f6749f8e1cec68f46f5356', 1792947018628],
  ['0003_w2a_plugin_ownership', '673c6b387cad3a6ab02943b78922783ed93bd0f7d65b82482e73be5c15af1c5b', 1793035108256],
  ['0004_w2b_plugin_ownership', '9aefa83091dc4057805cee22d6b8f03ec926d7768de8cc9ff8296d30b2b6c5b5', 1793038932247],
  ['0005_notification_registries', 'e4a92477364c3d5b0cad7c8da7cd633260f4dfdc74b607b999de060f27e21138', 1793038962541],
  ['0006_skills-projects-ownership', '52f10dd4509aa56e59667bee63e6d100149f6df771bf780d685969f94aaea6ec', 1793041810594],
  [
    '0007_tables_plugin_discriminators',
    '3041180056c14164ccfa873cd55753a9d04e8fc21cc4afe4807c7f87b2f87e4a',
    1793044499416,
  ],
  ['0008_plugin_artifact_kinds', '8e4f64cde77c1f10b0d963bec6cca8323dac96eb29c23aef1e6b3f821a9071e5', 1793045097691],
  [
    '0009_knowledge_plugin_ownership',
    '46d2c16cce788297ee3fbf052666533403b3127a7891684e44eba9fb04852ccc',
    1793047080800,
  ],
] as const;

describe('coreTableNames', () => {
  it('covers every table in the drizzle schema', () => {
    const derived = coreTableNames();
    const declared = Object.values(schema)
      .filter((value) => is(value, PgTable))
      .map((table) => getTableConfig(table as PgTable).name);
    expect(declared).toContain('users');
    expect(declared).toContain('conversations');
    expect(derived).toEqual(new Set(declared));
    expect(declared.filter((name) => !derived.has(name))).toEqual([]);
    expect(derived.size).toBe(49);
  });

  it('includes the extension lane bookkeeping table and nets drops', () => {
    expect(coreTableNames().has('extension_migrations')).toBe(true);
    expect(tablesTouchedBy('CREATE TABLE "a" (x int);\nDROP TABLE IF EXISTS "b";')).toEqual({
      creates: ['a'],
      drops: ['b'],
    });
  });
});

describe('core chains', () => {
  it('keeps the archived 3.x chain byte-identical to what 3.x installs recorded', () => {
    expect(readCoreMigrations(V3_ARCHIVE_FOLDER).map((m) => [m.tag, m.hash, m.folderMillis])).toEqual(ARCHIVED_3X);
  });

  it('starts 4.0 at one baseline journaled after the archived chain, creating only core tables', () => {
    const [baseline, ...later] = readCoreMigrations(MIGRATIONS_FOLDER);
    expect(baseline?.tag).toBe('0000_v4_baseline');
    expect(baseline!.folderMillis).toBeGreaterThan(ARCHIVED_3X.at(-1)![2]);
    for (const migration of later) expect(migration.folderMillis).toBeGreaterThan(baseline!.folderMillis);
    expect(new Set(baseline!.createsTables)).toEqual(coreTableNames());
  });
});
