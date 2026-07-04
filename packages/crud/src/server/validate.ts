/**
 * Fail-loud validation of list requests against a route's declared whitelist.
 *
 * The letpot-era filter layer silently dropped anything it did not recognise
 * (id filters that were not 24 chars, numeric selects, unknown keys) — so a
 * user could filter and get unfiltered results with no signal. Here every
 * unknown filter key, disallowed method, or unsortable key is a hard 400 with
 * a specific message.
 */

import { listParamsSchema } from '../protocol/schemas.js';
import type { FilterItem, FilterMethod, ListParams, SortItem } from '../protocol/types.js';

export interface FilterableSpec {
  /** Value coercion hint (also documents intent). */
  type?: 'text' | 'number' | 'date' | 'boolean' | 'id';
  /** Allowed methods for this key. Omit to allow every method. */
  methods?: FilterMethod[];
}

export interface ListContract {
  filterable?: Record<string, FilterableSpec>;
  sortable?: string[];
  defaultSort?: SortItem;
  defaultLimit?: number;
  maxLimit?: number;
}

export type ValidateResult =
  | { ok: true; params: Required<Pick<ListParams, 'skip' | 'limit'>> & ListParams }
  | { ok: false; error: string };

const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_LIMIT = 200;

/** Best-effort coercion of a filter value to the column's declared type. Leaves
 *  anything it can't safely convert untouched (validation already ran). */
function coerceFilterValue(v: unknown, type: 'number' | 'boolean'): unknown {
  if (type === 'number') {
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return v;
  }
  // boolean
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

/** Parse + validate a raw list body against the contract. */
export function validateListParams(raw: unknown, contract: ListContract): ValidateResult {
  const parsed = listParamsSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return { ok: false, error: `invalid list params: ${parsed.error.issues.map((i) => i.message).join('; ')}` };
  }
  const params = parsed.data;
  const filterable = contract.filterable ?? {};
  const sortable = new Set(contract.sortable ?? []);

  for (const f of params.filter ?? []) {
    const spec = filterable[f.key];
    if (!spec) {
      return { ok: false, error: `filter key "${f.key}" is not filterable` };
    }
    if (spec.methods && !spec.methods.includes(f.method)) {
      return { ok: false, error: `filter method "${f.method}" is not allowed on "${f.key}"` };
    }
    if ((f.method === 'in' || f.method === 'nin') && f.value.length === 0) {
      return { ok: false, error: `filter "${f.key}" with method "${f.method}" requires at least one value` };
    }
    if (f.method === 'between' && f.value.length !== 2) {
      return { ok: false, error: `filter "${f.key}" with method "between" requires exactly two values` };
    }
    if (f.method !== 'in' && f.method !== 'nin' && f.method !== 'between' && f.value.length < 1) {
      return { ok: false, error: `filter "${f.key}" requires a value` };
    }
    // Coerce values to the declared column type so a stringy filter (the client
    // <select> emits strings; a proxy/raw caller may too) matches a numeric or
    // boolean column instead of erroring with "operator does not exist: int = text".
    if (spec.type === 'number' || spec.type === 'boolean') {
      f.value = f.value.map((v) => coerceFilterValue(v, spec.type as 'number' | 'boolean'));
    }
  }

  for (const s of params.sort ?? []) {
    if (!sortable.has(s.key)) {
      return { ok: false, error: `sort key "${s.key}" is not sortable` };
    }
  }

  const maxLimit = contract.maxLimit ?? DEFAULT_MAX_LIMIT;
  const limit = Math.min(params.limit ?? contract.defaultLimit ?? DEFAULT_LIMIT, maxLimit);
  const skip = params.skip ?? 0;

  const sort: SortItem[] | undefined = params.sort ?? (contract.defaultSort ? [contract.defaultSort] : undefined);

  return {
    ok: true,
    params: {
      skip,
      limit,
      filter: params.filter as FilterItem[] | undefined,
      sort,
    },
  };
}
