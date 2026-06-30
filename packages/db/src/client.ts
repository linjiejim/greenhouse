/**
 * Drizzle client wiring — single place that owns the postgres.js connection.
 *
 * `Db` is the type every service factory takes; services never import the
 * driver directly.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index.js';

export type Db = PostgresJsDatabase<typeof schema>;

export interface DbClient {
  client: ReturnType<typeof postgres>;
  db: Db;
}

export function createDbClient(connectionString: string): DbClient {
  const client = postgres(connectionString, {
    max: 20,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {}, // Suppress "relation already exists" NOTICE logs
  });
  return { client, db: drizzle(client, { schema }) };
}
