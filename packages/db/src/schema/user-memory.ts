/**
 * Drizzle schema — User memory (PostgreSQL).
 *
 * Tables: user_memories
 *
 * Durable, user-scoped facts the agent was explicitly asked (or itself decided)
 * to remember. Written only through the `memory` tool / the self-service API —
 * there is no background extraction (v1's daily cron was removed, see
 * docs/specs/20260804-memory-v2.md).
 *
 * `title` is the recall index line: one sentence written to answer "is this
 * memory relevant to what the user just said", not a truncation of `content`.
 * Only titles are injected into the system prompt; bodies are pulled on demand.
 *
 * Lifecycle is a state machine, not a decaying score: active → dormant (unused
 * for 90 days, drops out of the index but stays searchable) → back to active on
 * any real use. Rows are never deleted by the system — consolidation marks them
 * `superseded` (with a pointer to the replacement) or `archived`.
 */

import { pgTable, serial, text, timestamp, integer, boolean, index, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './user.js';
import { bots } from './bots.js';

// ─── user_memories ────────────────────────────────────────

export const userMemories = pgTable(
  'user_memories',
  {
    id: serial('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    category: text('category', { enum: ['preference', 'fact', 'behavior'] })
      .notNull()
      .default('preference'),
    // 'preference' — response style, language, formatting
    // 'fact'       — role, projects, tech stack, domain
    // 'behavior'   — workflows, habits, recurring conventions
    /** One-line recall index — the only part injected into the system prompt. */
    title: text('title').notNull(),
    content: text('content').notNull(),
    status: text('status', { enum: ['active', 'dormant', 'archived', 'superseded'] })
      .notNull()
      .default('active'),
    /** Pinned memories never go dormant and sort first in the index. */
    pinned: boolean('pinned').notNull().default(false),
    source: text('source', { enum: ['user', 'agent', 'consolidation'] })
      .notNull()
      .default('agent'),
    /** Set when consolidation replaces this row; keeps the supersession chain readable. */
    superseded_by: integer('superseded_by').references((): AnyPgColumn => userMemories.id, {
      onDelete: 'set null',
    }),
    source_session_id: text('source_session_id'),
    /**
     * Scope: null = user-level (every agent and every Bot of this user sees it);
     * a Bot id = that Bot's private memory. Services take the scope as a
     * REQUIRED argument — null reads only user-level rows, a Bot id reads
     * user-level + its own (docs/specs/20261005-personal-assistant-bots.md §4.6).
     */
    bot_id: text('bot_id').references(() => bots.id, { onDelete: 'cascade' }),
    /** Refreshed on real use (recall / update) — NOT on prompt injection. */
    last_used_at: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_user_memories_user').on(table.user_id),
    index('idx_user_memories_category').on(table.user_id, table.category),
    index('idx_user_memories_status').on(table.user_id, table.status),
    index('idx_user_memories_bot')
      .on(table.bot_id)
      .where(sql`${table.bot_id} IS NOT NULL`),
  ],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type UserMemoryRow = typeof userMemories.$inferSelect;
export type UserMemoryCategory = UserMemoryRow['category'];
export type UserMemoryStatus = UserMemoryRow['status'];
export type UserMemorySource = UserMemoryRow['source'];
