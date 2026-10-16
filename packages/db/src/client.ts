/**
 * The one place that owns the postgres.js connection. Module services take a `Db`, which a
 * transaction also satisfies, so the same code runs inside and outside transactions.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Db = PostgresJsDatabase<Schema>;

export interface DbClient {
  sql: postgres.Sql;
  db: Db;
  close(): Promise<void>;
}

export function createDbClient(url: string, options: { max?: number } = {}): DbClient {
  const sql = postgres(url, {
    max: options.max ?? 20,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
  });
  return { sql, db: drizzle(sql, { schema }), close: () => sql.end() };
}

let current: Db | null = null;
const scoped = new AsyncLocalStorage<Db>();

/** The open transaction, else the database for this process (in a test, the test's own transaction). */
export function getDb(): Db {
  const db = scoped.getStore() ?? current;
  if (!db) throw new Error('Database not initialised: call setDb() at startup');
  return db;
}

/**
 * Set while a test transaction is installed: every connection is that one transaction, so two
 * independent transaction() calls would interleave their savepoints. They take turns instead.
 */
let serialize: (<T>(work: () => Promise<T>) => Promise<T>) | null = null;

/**
 * Runs fn in one transaction (a savepoint when one is already open). getDb() inside fn returns
 * the transaction, so any service fn calls joins it instead of reading around it.
 */
export function transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const open = () =>
    getDb().transaction((tx) => {
      const db = tx as unknown as Db;
      return scoped.run(db, () => fn(db));
    });
  // Nested calls run inside their parent's savepoint; only independent ones take turns.
  return serialize && !scoped.getStore() ? serialize(open) : open();
}

/** Install the process database. Tests swap in a transaction per test. */
export function setDb(db: Db | null, options: { serializeTransactions?: boolean } = {}): void {
  current = db;
  if (!db || !options.serializeTransactions) {
    serialize = null;
    return;
  }
  let tail: Promise<unknown> = Promise.resolve();
  serialize = <T>(work: () => Promise<T>) => {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  };
}
