import { createDatabase } from '@greenhouse/db';
import { resetIntegrationTestDatabase, TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { bootstrapPlatform } from '../../apps/api/src/platform/bootstrap.js';

export async function setup(): Promise<void> {
  await resetIntegrationTestDatabase(TEST_DATABASE_URL);
  const db = createDatabase(TEST_DATABASE_URL);
  try {
    // Platform manifests, protected roles and their baseline policies are
    // immutable test fixtures. Commit them once; per-test users bind to these
    // roles inside their rollback transaction.
    await bootstrapPlatform(db);
  } finally {
    await db.close();
  }
}
