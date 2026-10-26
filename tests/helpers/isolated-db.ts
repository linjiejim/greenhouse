/** DDL/retention fixtures own a database so parallel files cannot erase their rows.
 * Budget setup/teardown for migration IO and PostgreSQL checkpoints on database drop. */
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { applyAllMigrations } from '@greenhouse/db';
import { TEST_DATABASE_URL, recreateDatabase, dropDatabase } from '@greenhouse/db/test-config';

export async function isolatedDatabase(prefix: string) {
  const name = `${prefix}_${randomBytes(5).toString('hex')}_test`;
  const url = await recreateDatabase(TEST_DATABASE_URL, name);
  try {
    await applyAllMigrations(url, { folder: resolve(import.meta.dirname, '../../drizzle') });
    return { url, drop: () => dropDatabase(TEST_DATABASE_URL, name) };
  } catch (error) {
    await dropDatabase(TEST_DATABASE_URL, name);
    throw error;
  }
}
