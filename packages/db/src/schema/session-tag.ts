/**
 * Drizzle schema — User-defined session tags.
 *
 * Tables: session_tags, session_tag_links
 */

import { pgTable, serial, text, integer, timestamp, index, unique } from 'drizzle-orm/pg-core';

// ─── session_tags ─────────────────────────────────────────

export const sessionTags = pgTable(
  'session_tags',
  {
    id: serial('id').primaryKey(),
    user_id: text('user_id').notNull(),
    name: text('name').notNull(),
    color: text('color').notNull().default('#6B7280'),
    sort_order: integer('sort_order').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_session_tags_user').on(table.user_id),
    unique('uq_session_tags_user_name').on(table.user_id, table.name),
  ],
);

// ─── session_tag_links ────────────────────────────────────

export const sessionTagLinks = pgTable(
  'session_tag_links',
  {
    id: serial('id').primaryKey(),
    session_id: text('session_id').notNull(),
    tag_id: integer('tag_id')
      .notNull()
      .references(() => sessionTags.id, { onDelete: 'cascade' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_session_tag_links_session').on(table.session_id),
    index('idx_session_tag_links_tag').on(table.tag_id),
    unique('uq_session_tag_links').on(table.session_id, table.tag_id),
  ],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type SessionTagRow = typeof sessionTags.$inferSelect;
export type SessionTagLinkRow = typeof sessionTagLinks.$inferSelect;
