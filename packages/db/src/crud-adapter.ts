/**
 * Drizzle CRUD adapter — turns a plain Drizzle table into a `CrudService` the
 * @greenhouse/crud route factory can drive. This is the "build a table → get a
 * CRUD API" half of the low-code framework; the client half consumes the routes
 * that `createCrudRoutes(createTableCrudService(...))` exposes.
 *
 * The route layer has already whitelisted filter/sort keys (fail-loud), so the
 * translation here trusts its inputs and only maps protocol → Drizzle. Tables
 * with `created_at` / `updated_at` (the repo convention: notNull, no DB default,
 * mode:'string') get those columns stamped automatically on create/update.
 */

import {
  and,
  asc,
  between,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { nowIso } from '@greenhouse/utils/date';

import type { CrudService, FilterItem, ListParams, ListResult, SortItem } from '@greenhouse/crud/server';
import type { Db } from './client.js';

export interface TableCrudOptions {
  /** Primary-key column name. Default 'id'. */
  idColumn?: string;
  /** Applied when a list request carries no explicit sort. */
  defaultSort?: SortItem;
  /** Whitelist of columns writable on create/update. Omit to allow any provided key
   *  that maps to a real column (timestamps + id are always managed internally). */
  writable?: string[];
  /** Map a DB row to the API shape (e.g. parse a JSON text column). */
  transformOut?: (row: any) => any;
  /** Map an incoming payload to DB columns (e.g. stringify a JSON field). */
  transformIn?: (data: Record<string, unknown>) => Record<string, unknown>;
}

function col(table: PgTable, key: string): any {
  return (table as any)[key];
}

/** URL ids arrive as strings; serial PKs are numbers. Coerce numeric-looking ids. */
function coerceId(value: string): string | number {
  return /^-?\d+$/.test(value) ? Number(value) : value;
}

function buildWhere(table: PgTable, filters: FilterItem[] | undefined): SQL | undefined {
  if (!filters || filters.length === 0) return undefined;
  const conds: SQL[] = [];
  for (const f of filters) {
    const c = col(table, f.key);
    if (!c) continue; // route layer already whitelisted; skip defensively
    const v = f.value;
    switch (f.method) {
      case 'eq':
        conds.push(eq(c, v[0]));
        break;
      case 'ne':
        conds.push(ne(c, v[0]));
        break;
      case 'like':
      case 'ilike':
        conds.push(ilike(c, `%${String(v[0])}%`));
        break;
      case 'in':
        conds.push(inArray(c, v as any[]));
        break;
      case 'nin':
        conds.push(notInArray(c, v as any[]));
        break;
      case 'gt':
        conds.push(gt(c, v[0]));
        break;
      case 'gte':
        conds.push(gte(c, v[0]));
        break;
      case 'lt':
        conds.push(lt(c, v[0]));
        break;
      case 'lte':
        conds.push(lte(c, v[0]));
        break;
      case 'between':
        conds.push(between(c, v[0] as any, v[1] as any));
        break;
      case 'exists':
        conds.push(v[0] ? isNotNull(c) : isNull(c));
        break;
    }
  }
  if (conds.length === 0) return undefined;
  return conds.length === 1 ? conds[0] : and(...conds);
}

function buildOrderBy(table: PgTable, sort: SortItem[] | undefined, defaultSort?: SortItem): SQL[] {
  const items = sort && sort.length > 0 ? sort : defaultSort ? [defaultSort] : [];
  const out: SQL[] = [];
  for (const s of items) {
    const c = col(table, s.key);
    if (!c) continue;
    out.push(s.order === 'asc' ? asc(c) : desc(c));
  }
  return out;
}

export function createTableCrudService<TRow>(db: Db, table: PgTable, opts: TableCrudOptions = {}): CrudService<TRow> {
  const idKey = opts.idColumn ?? 'id';
  const idCol = col(table, idKey);
  const hasCreatedAt = !!col(table, 'created_at');
  const hasUpdatedAt = !!col(table, 'updated_at');
  const out = (row: any) => (opts.transformOut ? opts.transformOut(row) : row);

  function sanitizeWrite(data: Record<string, unknown>): Record<string, unknown> {
    const mapped = opts.transformIn ? opts.transformIn(data) : data;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(mapped)) {
      if (k === idKey || k === 'created_at' || k === 'updated_at') continue; // managed internally
      if (opts.writable && !opts.writable.includes(k)) continue;
      if (!col(table, k)) continue; // ignore keys that are not real columns
      result[k] = v;
    }
    return result;
  }

  return {
    async list(params: ListParams): Promise<ListResult<TRow>> {
      const where = buildWhere(table, params.filter);
      const orderBy = buildOrderBy(table, params.sort, opts.defaultSort);
      const limit = params.limit ?? 20;
      const skip = params.skip ?? 0;

      let q: any = db.select().from(table as any);
      if (where) q = q.where(where);
      if (orderBy.length) q = q.orderBy(...orderBy);
      const rows = await q.limit(limit).offset(skip);

      let countQ: any = db.select({ value: sql<number>`count(*)::int` }).from(table as any);
      if (where) countQ = countQ.where(where);
      const [{ value: total }] = await countQ;

      return { items: rows.map(out) as TRow[], total: Number(total) };
    },

    async get(id: string): Promise<TRow | null> {
      const [row] = await db
        .select()
        .from(table as any)
        .where(eq(idCol, coerceId(id)))
        .limit(1);
      return row ? (out(row) as TRow) : null;
    },

    async create(data: Record<string, unknown>): Promise<TRow> {
      const values = sanitizeWrite(data);
      const now = nowIso();
      if (hasCreatedAt && values.created_at === undefined) values.created_at = now;
      if (hasUpdatedAt && values.updated_at === undefined) values.updated_at = now;
      const [row] = await db
        .insert(table as any)
        .values(values as any)
        .returning();
      return out(row) as TRow;
    },

    async update(id: string, data: Record<string, unknown>): Promise<TRow | null> {
      const values = sanitizeWrite(data);
      if (hasUpdatedAt) values.updated_at = nowIso();
      if (Object.keys(values).length === 0) {
        // Nothing writable to set (empty/all-stripped body on a table without an
        // updated_at column). Drizzle would emit `SET  WHERE` — a SQL syntax
        // error — so treat it as a no-op and return the row unchanged.
        const [row] = await db
          .select()
          .from(table as any)
          .where(eq(idCol, coerceId(id)))
          .limit(1);
        return row ? (out(row) as TRow) : null;
      }
      const [row] = await db
        .update(table as any)
        .set(values as any)
        .where(eq(idCol, coerceId(id)))
        .returning();
      return row ? (out(row) as TRow) : null;
    },

    async remove(id: string): Promise<boolean> {
      const rows = await db
        .delete(table as any)
        .where(eq(idCol, coerceId(id)))
        .returning({ id: idCol });
      return rows.length > 0;
    },
  };
}
