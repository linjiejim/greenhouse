/**
 * The one place that owns the postgres.js connection. Module services take a `Db`, which a
 * transaction also satisfies, so the same code runs inside and outside transactions.
 */

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

/** The database for this process (or, in a test, the test's own transaction). */
export function getDb(): Db {
  if (!current) throw new Error('Database not initialised: call setDb() at startup');
  return current;
}

/** Install the process database. Tests swap in a transaction per test. */
export function setDb(db: Db | null): void {
  current = db;
}
