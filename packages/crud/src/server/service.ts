/**
 * CrudService — the data-source abstraction the route factory drives. Implement
 * it over Drizzle (see @greenhouse/db `createTableCrudService`), over an
 * in-memory array (demos/tests), or as a proxy that forwards to an external
 * admin API (a fork whose backend owns no tables).
 */

import type { ListParams, ListResult } from '../protocol/types.js';

export interface CrudService<TRow> {
  list(params: ListParams): Promise<ListResult<TRow>>;
  /** Return null when the row does not exist. */
  get(id: string): Promise<TRow | null>;
  create(data: Record<string, unknown>): Promise<TRow>;
  /** Return null when the row does not exist. */
  update(id: string, data: Record<string, unknown>): Promise<TRow | null>;
  /** Return false when the row did not exist. */
  remove(id: string): Promise<boolean>;
}
