/**
 * Column helpers shared by every schema file (conventions: packages/db/src/AGENTS.md).
 *
 * - ids are text; new rows get `newId(kind)` (ids.ts), carried 1.x rows keep theirs;
 * - points in time are timestamptz read as ISO strings, `created_at` / `updated_at`
 *   default to now();
 * - JSON is jsonb and never null unless null itself means something;
 * - enumerations are text plus a CHECK constraint (`oneOf`).
 */

import { sql, type SQL } from 'drizzle-orm';
import { check, customType, date, jsonb, text, timestamp, type AnyPgColumn } from 'drizzle-orm/pg-core';

/** Text primary key; the application assigns it. */
export const id = () => text('id').primaryKey();

/** A point in time, stored as timestamptz and read as an ISO string. */
export const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

/** A calendar day (`YYYY-MM-DD`). */
export const day = (name: string) => date(name, { mode: 'string' });

export const createdAt = () => at('created_at').notNull().defaultNow();
export const updatedAt = () => at('updated_at').notNull().defaultNow();

/** jsonb that is never null; `fallback` is its default. */
export function json<T>(name: string, fallback: T) {
  return jsonb(name)
    .$type<T>()
    .notNull()
    .default(sql.raw(`'${JSON.stringify(fallback).replace(/'/g, "''")}'::jsonb`) as never);
}

/** jsonb where null means "not set". */
export function jsonOrNull<T>(name: string) {
  return jsonb(name).$type<T>();
}

/** CHECK that a text column holds one of `values` (nulls pass; add notNull separately). */
export function oneOf(name: string, column: AnyPgColumn, values: readonly string[]) {
  const list = sql.join(
    values.map((value) => sql.raw(`'${value.replace(/'/g, "''")}'`)),
    sql`, `,
  );
  return check(name, sql`${column} IN (${list})`);
}

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/**
 * Full-text search for Chinese and English: the application writes jieba-segmented
 * tokens (`segmentForFts`, services/fts.ts) into three weighted columns and the
 * vector is generated from them, so its definition exists once. Titles go in A,
 * summaries in B, bodies in C.
 */
export const searchColumns = () => ({
  search_a: text('search_a').notNull().default(''),
  search_b: text('search_b').notNull().default(''),
  search_c: text('search_c').notNull().default(''),
  search_tsv: tsvector('search_tsv').generatedAlwaysAs(
    sql`setweight(to_tsvector('simple', search_a), 'A') || setweight(to_tsvector('simple', search_b), 'B') || setweight(to_tsvector('simple', search_c), 'C')`,
  ),
});

export type { SQL };
