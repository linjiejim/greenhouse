/**
 * Fork extension point for DB services + reset tables — the ONLY file a
 * downstream fork edits to add private domain tables/services.
 *
 * `DatabaseProvider` is INFERRED from `createDatabase` (no handwritten interface),
 * and `createDatabase` spreads `createExtensionServices(db)` into the provider it
 * returns. So a fork that returns its private services here (e.g. `{ crm: ... }`)
 * gets a fully-typed `db.crm.*` automatically — WITHOUT editing provider.ts, and
 * WITHOUT the dynamic-registry abstraction the spec deliberately avoids for the
 * DB layer. Empty upstream ⇒ `DatabaseProvider` is unchanged.
 *
 * Fork tables are plain Drizzle table objects the fork's services query via the
 * query builder (`db.select().from(crmTable)`), which needs no change to the
 * client's schema generic. Fork migrations live in the fork's OWN drizzle
 * namespace (e.g. `drizzle-fork/`), never in this package's chain.
 *
 * Fork example (in the fork's copy of this file):
 *   import { createCrmService } from './services/crm.js';
 *   export function createExtensionServices(db: Db) {
 *     return { crm: createCrmService(db) };
 *   }
 *   export const EXTENSION_RESET_TABLES = ['crm_customers', 'crm_deals'];
 */

import type { Db } from './client.js';

/** Private domain services contributed by a downstream fork. Empty upstream. */
export function createExtensionServices(_db: Db) {
  return {};
}

/** Extra tables a fork's `resetSchema()` should TRUNCATE for test isolation. Empty upstream. */
export const EXTENSION_RESET_TABLES: string[] = [];
