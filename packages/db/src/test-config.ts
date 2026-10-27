import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

import { V3_ARCHIVE_FOLDER } from './migrate.js';
import { createDatabase, createTestTransactionDatabase, type DatabaseProvider } from './provider.js';
import { createDbClient, type Db, type DbClient } from './client.js';
import { clearActiveTestTransactionProvider, setActiveTestTransactionProvider } from './test-runtime.js';

/**
 * PostgreSQL URL shared by integration tests. CI's service container is the
 * only place the default applies: a local run must name its disposable
 * database, because port 5432 on a workstation often belongs to another
 * project and the DB tests empty the database they reach.
 */
export const TEST_DATABASE_URL = resolveTestDatabaseUrl();

function resolveTestDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  if (process.env.CI) return 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test';
  return 'postgresql://unset@invalid.test/set_TEST_DATABASE_URL';
}

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

  if (url.hostname === 'invalid.test') {
    throw new Error(
      'TEST_DATABASE_URL is not set. Point it at a disposable database (name containing "test" or "e2e"); ' +
        'outside CI there is no default, so tests never reach a database another project owns.',
    );
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
  await db.executeRaw(sql`DELETE FROM budget_ledger WHERE account_id = ${accountId}`);
  await db.executeRaw(sql`DELETE FROM budget_reservations WHERE account_id = ${accountId}`);
  await db.executeRaw(sql`DELETE FROM budgets WHERE id = ${accountId}`);
}

/** Directional cleanup for Runtime Kernel db-commit concurrency tests only. */
export async function cleanupRuntimeTestRun(db: DatabaseProvider, runId: string): Promise<void> {
  // All run child rows use FK CASCADE from runs; run files are logical links.
  // Production exposes no deletion path; this helper is intentionally test-only.
  await db.executeRaw(sql`DELETE FROM files WHERE source = 'run' AND run_id = ${runId}`);
  await db.executeRaw(sql`DELETE FROM runs WHERE id = ${runId}`);
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

/** The URL of database `name` on the same server as `base`. */
export function siblingUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Drop (if present) and create a throwaway database next to `base`; its name must contain "test". */
export async function recreateDatabase(base: string, name: string): Promise<string> {
  const target = siblingUrl(base, name);
  assertSafeTestDatabase(target);
  const admin = postgres(siblingUrl(base, 'postgres'), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  return target;
}

export async function dropDatabase(base: string, name: string): Promise<void> {
  assertSafeTestDatabase(siblingUrl(base, name));
  const admin = postgres(siblingUrl(base, 'postgres'), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/** Run one SQL text against `url` and return its rows (assertions in tests). */
export async function queryRows(url: string, text: string): Promise<Array<Record<string, unknown>>> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return [...(await sql.unsafe(text))] as Array<Record<string, unknown>>;
  } finally {
    await sql.end();
  }
}

/** The tag a 3.0.2 install ends at: the archived chain 0000–0002. */
export const V3_0_2_LATEST_TAG = '0002_mcp_connectors';

/**
 * Build a 3.x database the way a 3.x release did: drizzle's own migrator over
 * the archived 3.x chain, cut after `through` (default: what 3.0.2 ships).
 */
export async function buildV3Database(url: string, through = V3_0_2_LATEST_TAG): Promise<void> {
  assertSafeTestDatabase(url);
  const journal = JSON.parse(readFileSync(join(V3_ARCHIVE_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  const end = journal.entries.findIndex((entry) => entry.tag === through);
  if (end === -1) throw new Error(`No archived 3.x migration tagged ${through}`);
  const folder = mkdtempSync(join(tmpdir(), 'gh-v3-chain-'));
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    mkdirSync(join(folder, 'meta'));
    journal.entries = journal.entries.slice(0, end + 1);
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries) {
      copyFileSync(join(V3_ARCHIVE_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    }
    await migrate(drizzle(sql), { migrationsFolder: folder });
  } finally {
    await sql.end();
    rmSync(folder, { recursive: true, force: true });
  }
}

/** A raw single-connection client on the test database (lock-holding race tests). */
export function openTestConnection(connectionString = TEST_DATABASE_URL): DbClient['client'] {
  assertSafeTestDatabase(connectionString);
  return createDbClient(connectionString).client;
}
