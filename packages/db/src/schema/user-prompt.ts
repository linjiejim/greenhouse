/**
 * Drizzle schema — User quick prompts (slash commands).
 *
 * Tables: user_prompts
 */

import { pgTable, serial, text, timestamp, integer, boolean, index } from 'drizzle-orm/pg-core';

// ─── user_prompts ─────────────────────────────────────────

export const userPrompts = pgTable(
  'user_prompts',
  {
    id: serial('id').primaryKey(),
    user_id: text('user_id').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    shortcut: text('shortcut'),
    sort_order: integer('sort_order').notNull().default(0),
    is_global: boolean('is_global').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_user_prompts_user').on(table.user_id)],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type UserPromptRow = typeof userPrompts.$inferSelect;
