/**
 * Drizzle schema — CRUD framework demo table (crud_demo_items).
 *
 * Backs the "CRUD Framework Demo" settings page: the end-to-end reference for
 * @greenhouse/crud (Drizzle adapter → createCrudRoutes → createRestDataSource →
 * CrudPage). Deliberately spans many column shapes (text, enum, number, boolean,
 * json-as-text, timestamps) so the demo exercises every built-in field type.
 * Not part of any product feature — safe to drop in a fork that doesn't want it.
 */

import { pgTable, serial, text, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';

export const crudDemoItems = pgTable(
  'crud_demo_items',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    category: text('category', { enum: ['plant', 'device', 'sensor', 'other'] })
      .notNull()
      .default('other'),
    status: text('status', { enum: ['draft', 'active', 'archived'] })
      .notNull()
      .default('draft'),
    priority: integer('priority').notNull().default(0),
    is_featured: boolean('is_featured').notNull().default(false),
    /** JSON string[] — parsed on the way out, stringified on the way in. */
    tags: text('tags'),
    notes: text('notes'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_crud_demo_items_status').on(table.status)],
);

export type CrudDemoItemRow = typeof crudDemoItems.$inferSelect;
