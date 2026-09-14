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
import { getActiveTestTransactionProvider } from './test-runtime.js';

export { createDatabase };
export type { DatabaseProvider };
export type { Db } from './client.js';

// Extension hooks: service bags, reset tables, and the extension migration lane.
export {
  registerExtensionServices,
  registerExtensionResetTables,
  getExtensionServices,
  _resetExtensionRegistrations,
} from './extensions.js';
export type { ExtensionServiceFactory } from './extensions.js';
export type {
  ExtensionMigrationSource,
  ExtensionMigrationStatus,
  ExtensionMigrationRunner,
} from './extension-migrations.js';
export { readCoreMigrations } from './core-migrations.js';
export type { CoreMigrationFile } from './core-migrations.js';

// ─── Public types ────────────────────────────────────────
// Row types + column-union types live next to the tables (type-only re-export;
// table objects themselves remain private to the database package.
export type * from './schema/index.js';

// Service factories + their Input/Opts/Result types.
export * from './services/sessions.js';
export * from './services/llm-calls.js';
export * from './services/eval.js';
export * from './services/chat-eval.js';
export * from './services/usage.js';
export * from './services/usage-budget.js';
export * from './services/users.js';
export * from './services/user-tools.js';
export * from './services/refresh-tokens.js';
export * from './services/account-password-links.js';
export * from './services/feature-requests.js';
export * from './services/projects.js';
export * from './services/api-clients.js';
export * from './services/api-audit.js';
export * from './services/user-prompts.js';
export * from './services/session-shares.js';
export * from './services/scheduled-tasks.js';
export * from './services/provider-tokens.js';
export * from './services/feishu-bot.js';
export * from './services/custom-profiles.js';
export * from './services/session-tags.js';
export * from './services/kb-comments.js';
export * from './services/knowledge-base.js';
export * from './services/knowledge-shares.js';
export * from './services/groups.js';
export * from './services/user-features.js';
export * from './services/user-memories.js';
export * from './services/tool-frictions.js';
export * from './services/drive.js';
export * from './services/email.js';
export * from './services/skills.js';
export * from './services/platform.js';
export * from './services/platform-oauth.js';
export * from './services/tables.js';
export * from './services/workflows.js';
export * from './services/chat-files.js';
export * from './services/agent-runs.js';
export * from './services/chat-artifact-receipts.js';
export * from './services/runtime.js';
export * from './services/notifications.js';
export * from './services/workspace-settings.js';

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
  const testProvider = getActiveTestTransactionProvider();
  if (testProvider) {
    _provider = testProvider;
    return testProvider;
  }

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
