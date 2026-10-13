/**
 * Test support: a disposable database, migrated once per run, and one transaction per test
 * that is rolled back afterwards. Nested service transactions become savepoints.
 */

import { applyMigrations } from './migrate.js';
import { createDbClient, setDb, type Db, type DbClient } from './client.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test';

/** Only a loopback database whose name says test or e2e may be written by tests. */
export function assertSafeTestDatabase(url: string): void {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  const name = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
  if (!loopback || !/(?:test|e2e)/i.test(name)) {
    throw new Error(`Refusing to run tests against ${host}/${name}: use a loopback database named *test*`);
  }
}

/** Reset the test database to an empty schema and apply the migrations. */
export async function prepareTestDatabase(url = TEST_DATABASE_URL): Promise<void> {
  assertSafeTestDatabase(url);
  const client = createDbClient(url, { max: 1 });
  try {
    await client.sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE;');
    await client.sql.unsafe('CREATE SCHEMA public;');
  } finally {
    await client.close();
  }
  await applyMigrations(url);
}

const ROLLBACK = Symbol('rollback');
let shared: DbClient | null = null;

export interface TestTransaction {
  db: Db;
  rollback(): Promise<void>;
}

/** Open a transaction for one test and install it as the process database. */
export async function startTestTransaction(url = TEST_DATABASE_URL): Promise<TestTransaction> {
  assertSafeTestDatabase(url);
  shared ??= createDbClient(url, { max: 4 });
  let release!: () => void;
  let ready!: (db: Db) => void;
  let fail!: (error: unknown) => void;
  const started = new Promise<Db>((resolve, reject) => {
    ready = resolve;
    fail = reject;
  });
  const finished = shared.db
    .transaction(async (tx) => {
      ready(tx as unknown as Db);
      await new Promise<void>((resolve) => (release = resolve));
      throw ROLLBACK;
    })
    .catch((error: unknown) => {
      if (error !== ROLLBACK) fail(error);
    });
  const db = await started;
  setDb(db);
  let done = false;
  return {
    db,
    async rollback() {
      if (done) return;
      done = true;
      release();
      await finished;
      setDb(null);
    },
  };
}

export async function closeTestConnection(): Promise<void> {
  const client = shared;
  shared = null;
  await client?.close();
}
