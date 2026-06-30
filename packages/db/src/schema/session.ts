/**
 * Drizzle schema — Session & Message tables (PostgreSQL).
 *
 * Tables: sessions, messages
 */

import { pgTable, text, timestamp, integer, doublePrecision, index } from 'drizzle-orm/pg-core';

// ─── sessions ─────────────────────────────────────────────

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    title: text('title'),
    status: text('status').notNull().default('active'),
    profile_id: text('profile_id').notNull().default('default'),
    user_id: text('user_id'),
    app_id: text('app_id'),
    channel: text('channel').notNull().default('web'), // 'web' | 'api' | 'a2a' | 'task' | 'subagent'
    // When this session was spawned by another session (via the spawn_session
    // tool), this points at the parent. Top-level sessions leave it null. Lineage
    // depth is tracked in metadata.spawn_depth.
    parent_session_id: text('parent_session_id'),
    rating: integer('rating'),
    comment: text('comment'),
    feedback: text('feedback'),
    metadata: text('metadata').notNull().default('{}'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_sessions_user').on(table.user_id),
    index('idx_sessions_app_id').on(table.app_id),
    index('idx_sessions_channel').on(table.channel),
    index('idx_sessions_parent').on(table.parent_session_id),
  ],
);

// ─── messages ─────────────────────────────────────────────

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    session_id: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    references_: text('references_').notNull().default('[]'),
    pipeline: text('pipeline').notNull().default('[]'),
    reasoning: text('reasoning'),
    images: text('images').notNull().default('[]'),
    confidence: doublePrecision('confidence'),
    grounded: integer('grounded'),
    input_tokens: integer('input_tokens'),
    output_tokens: integer('output_tokens'),
    cached_tokens: integer('cached_tokens'),
    reasoning_tokens: integer('reasoning_tokens'),
    duration_ms: integer('duration_ms'),
    seq: integer('seq').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_messages_session').on(table.session_id)],
);
