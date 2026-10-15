import { disposeTestServices } from '../../apps/api/src/testing.js';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { createDbClient, setDb, type DbClient } from '@greenhouse/db';
import { assertSafeTestDatabase, TEST_DATABASE_URL } from '@greenhouse/db/testing';

// Commit-level tests use a real pool, so concurrent transactions really run on separate
// connections. Each test cleans up the rows it committed.
let client: DbClient | null = null;

beforeAll(() => {
  assertSafeTestDatabase(TEST_DATABASE_URL);
  client = createDbClient(TEST_DATABASE_URL, { max: 10 });
  setDb(client.db);
});

afterEach(() => disposeTestServices());

afterAll(async () => {
  setDb(null);
  await client?.close();
});
