/**
 * Extension hooks of the database package — see EXTENDING.md.
 *
 * An extension owns its tables (created by its own migrations, applied by
 * `extension-migrations.ts`) and its services. Factories registered here are
 * instantiated once per provider and exposed under `db.extensions[<id>]`; the
 * extension keeps a typed accessor for its own bag (`getExtensionServices`).
 * Reset tables are truncated with the core tables between integration tests.
 */
import type { Db } from './client.js';

export type ExtensionServiceFactory = (db: Db) => Record<string, unknown>;

const serviceFactories = new Map<string, ExtensionServiceFactory>();
const resetTables: string[] = [];

/** Register the service factory of one extension. Call before `initDatabase`. */
export function registerExtensionServices(id: string, factory: ExtensionServiceFactory): void {
  if (serviceFactories.has(id)) throw new Error(`Extension services for "${id}" are registered twice`);
  serviceFactories.set(id, factory);
}

/** Tables an extension owns, truncated alongside the core tables by `resetSchema()` (tests, `pnpm cli db reset`). */
export function registerExtensionResetTables(tables: readonly string[]): void {
  for (const table of tables) if (!resetTables.includes(table)) resetTables.push(table);
}

export function extensionResetTables(): readonly string[] {
  return resetTables;
}

export function buildExtensionServices(db: Db): Record<string, Record<string, unknown>> {
  const bag: Record<string, Record<string, unknown>> = {};
  for (const [id, factory] of serviceFactories) bag[id] = factory(db);
  return bag;
}

/** Typed access to an extension's own services: `getExtensionServices<CrmServices>(db, 'crm')`. */
export function getExtensionServices<T>(provider: { extensions: Record<string, unknown> }, id: string): T {
  const services = provider.extensions[id];
  if (!services)
    throw new Error(`Extension "${id}" has no registered services — is it enabled in greenhouse.config.ts?`);
  return services as T;
}

/** Test hook — drop every registration so suites can register their own fixtures. */
export function _resetExtensionRegistrations(): void {
  serviceFactories.clear();
  resetTables.length = 0;
}
