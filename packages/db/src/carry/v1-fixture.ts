/**
 * A throwaway Greenhouse 1.6 database for migrate-from-1x tests: the archived
 * 1.x migration chain (drizzle/archive-1x) applied to a fresh database, plus
 * tests/fixtures/v1-6-seed.sql. Databases are created next to TEST_DATABASE_URL
 * (same server, names containing "test") and dropped by `dropDatabase`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { assertSafeTestDatabase } from '../test-config.js';
import { V1_ARCHIVE_FOLDER } from '../migrate.js';

const SEED = fileURLToPath(new URL('../../../../tests/fixtures/v1-6-seed.sql', import.meta.url));

/** The URL of database `name` on the same server as `base`. */
export function siblingUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

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

/** Apply the archived 1.x chain and (unless `seed: false`) the fixture data. */
export async function buildV1Database(url: string, options: { seed?: boolean } = {}): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: V1_ARCHIVE_FOLDER });
    if (options.seed !== false) await sql.unsafe(readFileSync(SEED, 'utf8'));
  } finally {
    await sql.end();
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
