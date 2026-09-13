import { sql } from 'drizzle-orm';

import { createDatabase, createTestTransactionDatabase, type DatabaseProvider } from './provider.js';
import { createDbClient, type Db, type DbClient } from './client.js';
import { clearActiveTestTransactionProvider, setActiveTestTransactionProvider } from './test-runtime.js';

/** PostgreSQL URL shared by integration tests; override for disposable databases. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test';

const UNSAFE_OVERRIDE = 'I_UNDERSTAND_TEST_DATABASE_IS_DESTRUCTIVE';
const ROLLBACK = Symbol('rollback integration test');
let reusableTestClient: DbClient | null = null;
let reusableTestConnectionString: string | null = null;

/** Fail before fixture cleanup unless the target is unmistakably disposable. */
export function assertSafeTestDatabase(
  connectionString: string,
  override = process.env.TEST_DATABASE_ALLOW_UNSAFE,
): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('TEST_DATABASE_URL is not a valid URL');
  }

  const host = url.hostname.toLowerCase();
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  const isClearlyTestDatabase = /(?:test|e2e)/i.test(database);

  if (isLoopback && isClearlyTestDatabase) return;
  if (override === UNSAFE_OVERRIDE) return;

  throw new Error(
    `Refusing destructive tests against ${host || '<missing-host>'}/${database || '<missing-db>'}. ` +
      'Use a loopback database whose name contains "test" or "e2e". ' +
      `Exceptional runs require TEST_DATABASE_ALLOW_UNSAFE=${UNSAFE_OVERRIDE}.`,
  );
}

/** Clean the disposable baseline once before the transaction-isolated DB project. */
export async function resetIntegrationTestDatabase(connectionString = TEST_DATABASE_URL): Promise<void> {
  assertSafeTestDatabase(connectionString);
  const provider = createDatabase(connectionString);
  try {
    await provider.initSchema();
    await provider.resetSchema();
  } finally {
    await provider.close();
  }
}

export interface TestTransaction {
  provider: DatabaseProvider;
  rollback(): Promise<void>;
}

function getReusableTestClient(connectionString: string): DbClient {
  if (reusableTestClient) {
    if (reusableTestConnectionString !== connectionString) {
      throw new Error('A test worker cannot reuse one PostgreSQL client across different TEST_DATABASE_URL values');
    }
    return reusableTestClient;
  }

  reusableTestClient = createDbClient(connectionString);
  reusableTestConnectionString = connectionString;
  return reusableTestClient;
}

/** Close the connection pool shared by the current test file/worker. */
export async function closeIntegrationTestConnection(): Promise<void> {
  const current = reusableTestClient;
  reusableTestClient = null;
  reusableTestConnectionString = null;
  if (current) await current.client.end();
}

/**
 * Directional cleanup for Usage Budget db-commit concurrency tests only.
 * Production exposes no ledger/account deletion path because those records are
 * permanent; keeping this raw cleanup behind the test-only export preserves
 * that invariant without leaking ORM primitives to application code.
 */
export async function cleanupUsageBudgetTestAccount(db: DatabaseProvider, accountId: string): Promise<void> {
  await db.executeRaw(sql`DELETE FROM usage_budget_ledger WHERE account_id = ${accountId}`);
  await db.executeRaw(sql`DELETE FROM usage_budget_reservations WHERE account_id = ${accountId}`);
  await db.executeRaw(sql`DELETE FROM usage_budget_accounts WHERE id = ${accountId}`);
}

/** Directional cleanup for Runtime Kernel db-commit concurrency tests only. */
export async function cleanupRuntimeTestRun(db: DatabaseProvider, runId: string): Promise<void> {
  // All runtime child rows use FK CASCADE from runtime_runs. Production exposes
  // no deletion path; this helper is intentionally test-only.
  await db.executeRaw(sql`DELETE FROM runtime_runs WHERE id = ${runId}`);
}

/**
 * Reuse the current worker's pool, reserve one connection for this test, and
 * expose a provider whose writes are rolled back afterward. Nested service
 * transactions become savepoints through drizzle/postgres.js.
 */
export async function startIntegrationTestTransaction(connectionString = TEST_DATABASE_URL): Promise<TestTransaction> {
  assertSafeTestDatabase(connectionString);
  const { db } = getReusableTestClient(connectionString);

  let releaseTransaction!: () => void;
  let resolveProvider!: (provider: DatabaseProvider) => void;
  let rejectProvider!: (error: unknown) => void;
  const providerReady = new Promise<DatabaseProvider>((resolve, reject) => {
    resolveProvider = resolve;
    rejectProvider = reject;
  });

  let transactionError: unknown;
  const transactionFinished = db
    .transaction(async (transaction) => {
      // A Drizzle transaction exposes the same query/transaction surface used
      // by every domain service. Nested service transactions become savepoints.
      const provider = createTestTransactionDatabase(transaction as unknown as Db);
      setActiveTestTransactionProvider(provider);
      resolveProvider(provider);
      await new Promise<void>((resolve) => {
        releaseTransaction = resolve;
      });
      throw ROLLBACK;
    })
    .catch((error: unknown) => {
      if (error !== ROLLBACK) {
        transactionError = error;
        rejectProvider(error);
      }
    });

  let provider: DatabaseProvider;
  try {
    provider = await providerReady;
  } catch (error) {
    await transactionFinished;
    await closeIntegrationTestConnection();
    throw error;
  }

  let rolledBack = false;
  return {
    provider,
    async rollback(): Promise<void> {
      if (rolledBack) return;
      rolledBack = true;
      releaseTransaction();
      try {
        await transactionFinished;
      } finally {
        clearActiveTestTransactionProvider(provider);
      }
      if (transactionError) throw transactionError;
    },
  };
}
