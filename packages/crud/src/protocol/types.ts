/**
 * CRUD wire protocol — the shape shared by the client data source, the server
 * route factory, and the Drizzle adapter. Deliberately kept flat and JSON-only
 * so a proxy (e.g. a fork forwarding to an external admin API) is a thin
 * translation, and shape-compatible with the letpot `/admin/:resource` protocol
 * (skip/limit/filter[]/sort[], POST /list).
 */

/** Comparison operators a filter can use. Superset of the letpot method set. */
export type FilterMethod =
  | 'eq'
  | 'ne'
  | 'like' // case-insensitive substring (maps to ILIKE %v%)
  | 'ilike'
  | 'in'
  | 'nin'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between' // value: [min, max]
  | 'exists'; // value: [true] → NOT NULL, [false] → NULL

export interface FilterItem {
  /** Column/field key. Validated against the route's `filterable` whitelist. */
  key: string;
  method: FilterMethod;
  /** Operands. Most methods read value[0]; `in`/`nin` read the whole array;
   *  `between` reads [min, max]; `exists` reads value[0] as a boolean. */
  value: unknown[];
}

export interface SortItem {
  key: string;
  order: 'asc' | 'desc';
}

export interface ListParams {
  /** Rows to skip (offset). Default 0. */
  skip?: number;
  /** Page size. Default 20, clamped to the route's maxLimit. */
  limit?: number;
  filter?: FilterItem[];
  sort?: SortItem[];
}

export interface ListResult<TRow> {
  items: TRow[];
  total: number;
}
