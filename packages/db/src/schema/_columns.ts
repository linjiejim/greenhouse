import { sql } from 'drizzle-orm';
import { customType, jsonb, text, timestamp } from 'drizzle-orm/pg-core';

/** Text primary key; the application assigns `newId(kind)`. */
export const id = () => text('id').primaryKey();

/** A point in time, stored as timestamptz and read as an ISO string. */
export const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

export const createdAt = () => at('created_at').notNull().defaultNow();
export const updatedAt = () => at('updated_at').notNull().defaultNow();

/** jsonb that is never null; `fallback` is its default. */
export function json<T>(name: string, fallback: T) {
  return jsonb(name)
    .$type<T>()
    .notNull()
    .default(fallback as never);
}

/** jsonb where null means "not set". */
export function jsonOrNull<T>(name: string) {
  return jsonb(name).$type<T>();
}

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/**
 * Full-text search for Chinese and English (data-model.md §1): the application writes segmented
 * tokens (`searchTokens` in search.ts) into three weighted columns and the vector is generated
 * from them, so its definition exists once. Titles go in A, summaries in B, bodies in C.
 */
export const searchColumns = () => ({
  searchA: text('search_a').notNull().default(''),
  searchB: text('search_b').notNull().default(''),
  searchC: text('search_c').notNull().default(''),
  searchTsv: tsvector('search_tsv').generatedAlwaysAs(
    sql`setweight(to_tsvector('simple', search_a), 'A') || setweight(to_tsvector('simple', search_b), 'B') || setweight(to_tsvector('simple', search_c), 'C')`,
  ),
});
