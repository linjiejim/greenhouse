import { jsonb, text, timestamp } from 'drizzle-orm/pg-core';

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
