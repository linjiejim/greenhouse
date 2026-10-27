import { afterEach, beforeEach, expect, it } from 'vitest';
import { initDatabase, _resetProvider, type DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
let db: DatabaseProvider;
beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
});
afterEach(async () => {
  await db.close();
  _resetProvider();
});
it('persists onInstall once across runner instances and retries a failed installation', async () => {
  const id = `install-${crypto.randomUUID()}`;
  const outcomes: string[] = [];
  await expect(
    db.extensionMigrations.installOnce(id, async () => {
      throw new Error('not installed');
    }),
  ).rejects.toThrow('not installed');
  expect(
    await db.extensionMigrations.installOnce(id, async () => {
      outcomes.push('installed');
    }),
  ).toBe(true);
  expect(
    await db.extensionMigrations.installOnce(id, async () => {
      outcomes.push('duplicate');
    }),
  ).toBe(false);
  expect(outcomes).toEqual(['installed']);
});
