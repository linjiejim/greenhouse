/**
 * Extension migration lane — applies ordered SQL files once, tracks them per
 * extension, refuses drift. Runs inside the transaction-isolated db project, so
 * the DDL below rolls back with the test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { initDatabase, _resetProvider, type DatabaseProvider } from './index.js';
import { TEST_DATABASE_URL } from './test-config.js';

let db: DatabaseProvider;
let dir: string;

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  dir = mkdtempSync(join(tmpdir(), 'gh-ext-migrations-'));
  writeFileSync(
    join(dir, '0001_create.sql'),
    'CREATE TABLE ext_mig_probe (id serial PRIMARY KEY, label text NOT NULL);\n--> statement-breakpoint\nCREATE INDEX ext_mig_probe_label ON ext_mig_probe (label);\n',
  );
  writeFileSync(join(dir, '0002_seed.sql'), "INSERT INTO ext_mig_probe (label) VALUES ('one'), ('two');\n");
});

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await db.close();
  _resetProvider();
});

describe('extension migrations', () => {
  it('applies pending files in order, once, and records them', async () => {
    const sources = [{ extensionId: 'probe', dir }];
    const first = await db.extensionMigrations.apply(sources);
    expect(first.applied).toEqual(['probe/0001_create.sql', 'probe/0002_seed.sql']);

    const rows = (await db.executeRaw(sql`SELECT count(*)::int AS n FROM ext_mig_probe`)) as Array<{ n: number }>;
    expect(rows[0].n).toBe(2);

    const second = await db.extensionMigrations.apply(sources);
    expect(second.applied).toEqual([]);

    const status = await db.extensionMigrations.status(sources);
    expect(status.map((s) => [s.name, s.applied, s.drifted])).toEqual([
      ['0001_create.sql', true, false],
      ['0002_seed.sql', true, false],
    ]);
  });

  it('refuses a file that changed after it was applied', async () => {
    const sources = [{ extensionId: 'probe', dir }];
    await db.extensionMigrations.apply(sources);
    writeFileSync(join(dir, '0002_seed.sql'), "INSERT INTO ext_mig_probe (label) VALUES ('three');\n");

    const status = await db.extensionMigrations.status(sources);
    expect(status.find((s) => s.name === '0002_seed.sql')?.drifted).toBe(true);
    await expect(db.extensionMigrations.apply(sources)).rejects.toThrow(/changed after it was applied/);
  });

  it('keeps extensions apart and tolerates a missing directory', async () => {
    const result = await db.extensionMigrations.apply([
      { extensionId: 'probe', dir },
      { extensionId: 'ghost', dir: join(dir, 'does-not-exist') },
    ]);
    expect(result.applied).toEqual(['probe/0001_create.sql', 'probe/0002_seed.sql']);
    const tracked = (await db.executeRaw(
      sql`SELECT extension_id, name FROM extension_migrations ORDER BY extension_id, name`,
    )) as Array<{ extension_id: string; name: string }>;
    expect(tracked.filter((r) => r.extension_id === 'probe')).toHaveLength(2);
    expect(tracked.some((r) => r.extension_id === 'ghost')).toBe(false);
  });
});
