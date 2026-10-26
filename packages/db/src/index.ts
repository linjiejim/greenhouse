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
  ExtensionMigrationGeneration,
  ExtensionMigrationState,
} from './extension-migrations.js';
export { parseMigrationFile, readMigrationFiles, extensionMigrationTables } from './extension-migrations.js';
export { readCoreMigrations, coreTableNames } from './core-migrations.js';
export { newId, isNewId, stableId, ulid, ID_PREFIX } from './ids.js';
export {
  applyMigrations,
  applyAllMigrations,
  assertMigratableDatabase,
  detectDatabaseGeneration,
  readCarryState,
  readCarryStateFromDb,
  refusalFor,
  DatabaseGenerationError,
  MIGRATIONS_FOLDER,
  V1_ARCHIVE_FOLDER,
  V1_LATEST_TAG,
} from './migrate.js';
export type { CarryState, AppliedMigrations } from './migrate.js';
export type { DatabaseGeneration } from './migrate.js';
export { carryFrom1x, CarryError, CarryFailedError, v1CoreTables } from './carry/from-1x.js';
export type { CarryOptions, CarryReport, CarryLine } from './carry/from-1x.js';
export type { IdKind } from './ids.js';
export type { CoreMigrationFile } from './core-migrations.js';

// ─── Public types ────────────────────────────────────────
// Row types + column-union types live next to the tables (type-only re-export;
// table objects themselves remain private to the database package.
export type * from './schema/index.js';

// Service factories + their Input/Opts/Result types.
export * from './services/sessions.js';
export * from './services/llm-calls.js';
export * from './services/usage.js';
export * from './services/usage-budget.js';
export * from './services/usage-counters.js';
export * from './services/metering.js';
export * from './services/security-state.js';
export * from './services/users.js';
export * from './services/user-tools.js';
export * from './services/refresh-tokens.js';
export * from './services/account-password-links.js';
export * from './services/api-audit.js';
export * from './services/user-prompts.js';
export * from './services/session-shares.js';
export * from './services/scheduled-tasks.js';
export * from './services/provider-tokens.js';
export * from './services/custom-profiles.js';
// Shared full-text helpers: an extension that keeps its own searchable table
// must segment writes and queries with the SAME function core uses, or the two
// sides stop matching — so this is exported rather than copied.
export { segmentForFts, buildSegmentedTsQuery } from './services/fts.js';
export * from './services/knowledge-base.js';
export * from './services/knowledge-shares.js';
export * from './services/user-features.js';
export * from './services/drive.js';
export * from './services/activity.js';
export * from './services/platform.js';
export * from './services/platform-oauth.js';
export * from './services/chat-files.js';
export * from './services/chat-artifact-receipts.js';
export * from './services/runtime.js';
export * from './services/notifications.js';
export * from './services/push-devices.js';
export * from './services/gateway-keys.js';
export * from './services/workspace-settings.js';
export * from './services/retention.js';
export * from './services/mcp-connectors.js';

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

export { registerExtensionRetention } from './extensions.js';
export type { ExtensionRetentionRule } from './extensions.js';
