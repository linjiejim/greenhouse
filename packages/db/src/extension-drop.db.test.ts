/** Plugin DDL is transaction-isolated just like migration lane tests. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { initDatabase, type DatabaseProvider } from './index.js';
import { TEST_DATABASE_URL } from './test-config.js';
let dir: string;
let db: DatabaseProvider;
beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  dir = mkdtempSync(join(tmpdir(), 'gh-drop-'));
  writeFileSync(
    join(dir, '0001.sql'),
    'CREATE TABLE ext_drop_parent (id integer PRIMARY KEY);\n--> statement-breakpoint\nCREATE TABLE ext_drop_child (id integer REFERENCES ext_drop_parent(id));',
  );
});
afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await db.close();
});
const source = () => ({ extensionId: 'drop-fixture', dir });
async function exists(name: string) {
  const rows = (await db.executeRaw(sql`SELECT to_regclass(${name}) AS name`)) as { name: string | null }[];
  return rows[0].name !== null;
}
describe('plugin data removal', () => {
  it('drops the whole lane and only that lane, permitting internal FKs', async () => {
    await db.extensionMigrations.apply([source()]);
    await db.executeRaw(
      sql`INSERT INTO extension_migrations (extension_id, name, checksum) VALUES ('other-drop-fixture', 'keep.sql', 'keep')`,
    );
    expect(await db.extensionMigrations.drop(source())).toEqual(['ext_drop_child', 'ext_drop_parent']);
    expect(await exists('ext_drop_parent')).toBe(false);
    expect(await exists('ext_drop_child')).toBe(false);
    const rows = (await db.executeRaw(
      sql`SELECT extension_id FROM extension_migrations WHERE extension_id IN ('drop-fixture', 'other-drop-fixture')`,
    )) as { extension_id: string }[];
    expect(rows.map((row) => row.extension_id)).toEqual(['other-drop-fixture']);
  });
  it('refuses core tables and rolls back if another lane depends on a table', async () => {
    await expect(db.extensionMigrations.drop(source(), ['users'])).rejects.toThrow(/protected/);
    await db.extensionMigrations.apply([source()]);
    await db.executeRaw(sql`CREATE TABLE ext_drop_foreign (id integer REFERENCES ext_drop_parent(id))`);
    await expect(db.extensionMigrations.drop(source())).rejects.toThrow();
    expect(await exists('ext_drop_parent')).toBe(true);
    expect((await db.extensionMigrations.status([source()]))[0].applied).toBe(true);
  });
});
