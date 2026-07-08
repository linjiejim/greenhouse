/**
 * Database entry point — singleton factory + the package's public surface.
 *
 * Usage:
 *   import { initDatabase, getDb } from '@greenhouse/db';
 *
 *   // At startup:
 *   await initDatabase({ type: 'pg', pgConnectionString: 'postgresql://...' });
 *
 *   // Anywhere else:
 *   const db = getDb();
 *   const user = await db.users.getByEmail('a@b.c');
 *
 * Types are inferred from the implementation (`DatabaseProvider`) and the
 * Drizzle schema (`$inferSelect` row types) — there is no handwritten
 * interface layer.
 */

import { createDatabase, type DatabaseProvider } from './provider.js';

export { createDatabase };
export type { DatabaseProvider };
export type { Db } from './client.js';

// ─── Public types ────────────────────────────────────────
// Row types + column-union types live next to the tables (type-only re-export;
// table objects themselves stay behind '@greenhouse/db/schema').
export type * from './schema/index.js';

// Generic CRUD adapter — turns a Drizzle table into a @greenhouse/crud service.
export * from './crud-adapter.js';

// Service factories + their Input/Opts/Result types.
export * from './services/sessions.js';
export * from './services/llm-calls.js';
export * from './services/usage.js';
export * from './services/users.js';
export * from './services/user-profiles.js';
export * from './services/user-tools.js';
export * from './services/refresh-tokens.js';
export * from './services/feature-requests.js';
export * from './services/projects.js';
export * from './services/api-clients.js';
export * from './services/api-audit.js';
export * from './services/admin-analytics.js';
export * from './services/llm-gateway.js';
export * from './services/user-prompts.js';
export * from './services/session-shares.js';
export * from './services/scheduled-tasks.js';
export * from './services/custom-profiles.js';
export * from './services/email-accounts.js';
export * from './services/session-tags.js';
export * from './services/knowledge-base.js';
export * from './services/knowledge-shares.js';
export * from './services/groups.js';
export * from './services/user-features.js';
export * from './services/user-memories.js';
export * from './services/skills.js';
export * from './services/im.js';

// ─── Configuration ───────────────────────────────────────

export interface DbConfig {
  type: 'pg';
  /** PostgreSQL connection string. */
  pgConnectionString: string;
}

// ─── Singleton Provider ──────────────────────────────────

let _provider: DatabaseProvider | null = null;

/**
 * Initialize the database provider. Must be called once at startup.
 */
export async function initDatabase(config: DbConfig): Promise<DatabaseProvider> {
  if (_provider) {
    await _provider.close();
    _provider = null;
  }

  _provider = createDatabase(config.pgConnectionString);
  await _provider.initSchema();
  return _provider;
}

/**
 * Get the initialized database provider.
 * Throws if initDatabase() has not been called.
 */
export function getDb(): DatabaseProvider {
  if (!_provider) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return _provider;
}

/** Check whether the database has been initialized. */
export function isDbInitialized(): boolean {
  return _provider !== null;
}

/**
 * Reset the provider singleton (for testing).
 * Does NOT close the provider — call provider.close() first if needed.
 */
export function _resetProvider(): void {
  _provider = null;
}
