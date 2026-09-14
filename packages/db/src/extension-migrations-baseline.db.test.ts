/** Adopting extension tables that already exist: record, never execute. */
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
  dir = mkdtempSync(join(tmpdir(), 'gh-ext-baseline-'));
  // Deliberately destructive SQL: if baseline executed it, the assertions below fail.
  writeFileSync(join(dir, '0001_create.sql'), 'DROP TABLE IF EXISTS users;\n');
});

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await db.close();
  _resetProvider();
});

describe('extension migration baseline', () => {
  it('marks pending files applied without running them', async () => {
    const sources = [{ extensionId: 'probe', dir }];
    const { recorded } = await db.extensionMigrations.baseline(sources);
    expect(recorded).toEqual(['probe/0001_create.sql']);

    // The file never ran: the table it would have dropped is still there.
    const [{ n }] = (await db.executeRaw(
      sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'users'`,
    )) as Array<{ n: number }>;
    expect(n).toBe(1);

    // And the runner now considers the lane clean.
    expect(await db.extensionMigrations.status(sources)).toEqual([
      { extensionId: 'probe', name: '0001_create.sql', applied: true, drifted: false },
    ]);
    expect((await db.extensionMigrations.apply(sources)).applied).toEqual([]);
    expect((await db.extensionMigrations.baseline(sources)).recorded).toEqual([]);
  });

  it('stops at --through, so the rest of the chain still applies', async () => {
    // 0002 is the migration written to finish adopting a database: it must run,
    // not be recorded away, even though everything before it is already there.
    writeFileSync(join(dir, '0002_adopt.sql'), 'CREATE TABLE IF NOT EXISTS baseline_probe (id int);\n');
    const sources = [{ extensionId: 'probe', dir }];

    const { recorded } = await db.extensionMigrations.baseline(sources, {
      through: { probe: '0001_create.sql' },
    });
    expect(recorded).toEqual(['probe/0001_create.sql']);

    // 0002 is still pending…
    expect(await db.extensionMigrations.status(sources)).toEqual([
      { extensionId: 'probe', name: '0001_create.sql', applied: true, drifted: false },
      { extensionId: 'probe', name: '0002_adopt.sql', applied: false, drifted: false },
    ]);
    // …and applying the lane runs exactly that one file.
    expect((await db.extensionMigrations.apply(sources)).applied).toEqual(['probe/0002_adopt.sql']);
    const [{ n }] = (await db.executeRaw(
      sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'baseline_probe'`,
    )) as Array<{ n: number }>;
    expect(n).toBe(1);
  });
});
