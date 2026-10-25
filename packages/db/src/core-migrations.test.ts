/** The core table set is derived from the migration chain; it must cover the whole drizzle schema. */
import { describe, expect, it } from 'vitest';
import { is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from './schema/index.js';
import { coreTableNames, tablesTouchedBy } from './core-migrations.js';

describe('coreTableNames', () => {
  it('covers every table in the drizzle schema', () => {
    const derived = coreTableNames();
    const declared = Object.values(schema)
      .filter((value) => is(value, PgTable))
      .map((table) => getTableConfig(table as PgTable).name);
    expect(declared.length).toBeGreaterThan(50);
    expect(declared.filter((name) => !derived.has(name))).toEqual([]);
  });

  it('includes the extension lane bookkeeping table and nets drops', () => {
    expect(coreTableNames().has('extension_migrations')).toBe(true);
    expect(tablesTouchedBy('CREATE TABLE "a" (x int);\nDROP TABLE IF EXISTS "b";')).toEqual({
      creates: ['a'],
      drops: ['b'],
    });
  });
});
