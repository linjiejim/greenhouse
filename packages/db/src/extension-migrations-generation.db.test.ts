/**
 * Core-generation markers in the extension lane: a `-- greenhouse:core-generation 1x`
 * file never runs on 3.0 — recorded as skipped on a fresh database, left alone on a
 * carried one that has its row, refused on a carried one that does not. The marker
 * is not part of the checksum, and unmarked files keep their exact old checksum.
 * Carried databases are simulated with the carry marker inside the test transaction.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { initDatabase, _resetProvider, parseMigrationFile, type DatabaseProvider } from './index.js';
import { TEST_DATABASE_URL } from './test-config.js';

const MARKER = '-- greenhouse:core-generation 1x\n';
// Destructive on purpose: if the lane ever executed it, `users` would be gone.
const V1_SQL = 'ALTER TABLE users ADD COLUMN gen_probe_never integer;\n';
const CREATE_SQL = 'CREATE TABLE ext_gen_probe (id serial PRIMARY KEY);\n';

let db: DatabaseProvider;
let dir: string;
const sources = () => [{ extensionId: 'genprobe', dir }];

async function markCarried(): Promise<void> {
  await db.executeRaw(sql`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await db.executeRaw(
    sql.raw(
      'CREATE TABLE IF NOT EXISTS drizzle.greenhouse_carry (id integer PRIMARY KEY CHECK (id = 1), ' +
        'source_version text, started_at timestamptz NOT NULL, completed_at timestamptz)',
    ),
  );
  await db.executeRaw(
    sql`INSERT INTO drizzle.greenhouse_carry (id, source_version, started_at, completed_at)
        VALUES (1, '0013_report_templates', now(), now())
        ON CONFLICT (id) DO UPDATE SET completed_at = now()`,
  );
}

async function record(name: string, checksum: string): Promise<void> {
  await db.extensionMigrations.status([]); // ensures the bookkeeping table
  await db.executeRaw(
    sql`INSERT INTO extension_migrations (extension_id, name, checksum) VALUES ('genprobe', ${name}, ${checksum})`,
  );
}

async function hasProbeColumn(): Promise<boolean> {
  const rows = (await db.executeRaw(
    sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'gen_probe_never'`,
  )) as Array<{ n: number }>;
  return rows[0]!.n > 0;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  dir = mkdtempSync(join(tmpdir(), 'gh-ext-generation-'));
  writeFileSync(join(dir, '0001_create.sql'), CREATE_SQL);
  writeFileSync(join(dir, '0002_v1.sql'), MARKER + V1_SQL);
});

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await db.close();
  _resetProvider();
});

describe('core-generation marker', () => {
  it('keeps the exact checksum of unmarked files and strips the marker from marked ones', () => {
    const plain = parseMigrationFile('0001_create.sql', CREATE_SQL);
    expect(plain.generation).toBeNull();
    expect(plain.checksum).toBe(sha(CREATE_SQL));
    const marked = parseMigrationFile('0002_v1.sql', MARKER + V1_SQL);
    expect(marked.generation).toBe('1x');
    expect(marked.checksum).toBe(sha(V1_SQL));
    expect(marked.statements).toEqual([V1_SQL.trim()]);
    expect(() => parseMigrationFile('x.sql', '-- greenhouse:core-generation 2x\nSELECT 1;')).toThrow(/unknown core/);
  });

  it('fresh database: records a 1x file as skipped without running it', async () => {
    const result = await db.extensionMigrations.apply(sources());
    expect(result).toEqual({ applied: ['genprobe/0001_create.sql'], skipped: ['genprobe/0002_v1.sql'] });
    expect(await hasProbeColumn()).toBe(false);

    const status = await db.extensionMigrations.status(sources());
    expect(status.map((s) => [s.name, s.generation, s.state, s.applied, s.drifted])).toEqual([
      ['0001_create.sql', null, 'applied', true, false],
      ['0002_v1.sql', '1x', 'skipped', true, false],
    ]);
    expect(await db.extensionMigrations.apply(sources())).toEqual({ applied: [], skipped: [] });
  });

  it('marking an already applied file does not count as a change', async () => {
    writeFileSync(join(dir, '0002_v1.sql'), V1_SQL);
    await db.extensionMigrations.baseline(sources());
    writeFileSync(join(dir, '0002_v1.sql'), MARKER + V1_SQL);
    const status = await db.extensionMigrations.status(sources());
    expect(status.every((s) => !s.drifted)).toBe(true);
    expect(await db.extensionMigrations.apply(sources())).toEqual({ applied: [], skipped: [] });
  });

  it('carried database with the row: nothing happens', async () => {
    await markCarried();
    await record('0001_create.sql', sha(CREATE_SQL));
    await db.executeRaw(sql.raw(CREATE_SQL));
    // The 1.x runner hashed the file as it saw it; either form is accepted.
    await record('0002_v1.sql', sha(MARKER + V1_SQL));
    expect(await db.extensionMigrations.apply(sources())).toEqual({ applied: [], skipped: [] });
    expect(await hasProbeColumn()).toBe(false);
    const status = await db.extensionMigrations.status(sources());
    expect(status.map((s) => [s.name, s.state, s.drifted])).toEqual([
      ['0001_create.sql', 'applied', false],
      ['0002_v1.sql', 'applied', false],
    ]);
  });

  it('carried database without the row: refuses, and baseline does not paper over it', async () => {
    await markCarried();
    await record('0001_create.sql', sha(CREATE_SQL));
    await db.executeRaw(sql.raw(CREATE_SQL));
    const status = await db.extensionMigrations.status(sources());
    expect(status.find((s) => s.name === '0002_v1.sql')?.state).toBe('missing');
    await expect(db.extensionMigrations.apply(sources())).rejects.toThrow(
      /genprobe\/0002_v1\.sql[\s\S]*never applied on the 1\.x database[\s\S]*migrate-from-1x again/,
    );
    expect((await db.extensionMigrations.baseline(sources())).recorded).toEqual([]);
    expect(await hasProbeColumn()).toBe(false);
  });

  it('carried database, extension first enabled on 3.0: its 1x files are skipped', async () => {
    await markCarried();
    expect(await db.extensionMigrations.apply(sources())).toEqual({
      applied: ['genprobe/0001_create.sql'],
      skipped: ['genprobe/0002_v1.sql'],
    });
    expect(await hasProbeColumn()).toBe(false);
  });

  it('refuses a current-generation file that creates a core table', async () => {
    writeFileSync(join(dir, '0003_clash.sql'), 'CREATE TABLE IF NOT EXISTS "users" (id int);\n');
    const status = await db.extensionMigrations.status(sources());
    expect(status.find((s) => s.name === '0003_clash.sql')?.collidesWithCore).toEqual(['users']);
    await expect(db.extensionMigrations.apply(sources())).rejects.toThrow(/creates core table\(s\) users/);
    // Nothing ran: the lane refuses before the first file.
    const rows = (await db.executeRaw(sql`SELECT to_regclass('public.ext_gen_probe')::text AS t`)) as Array<{
      t: string | null;
    }>;
    expect(rows[0]!.t).toBeNull();
  });
});
