/**
 * Drizzle schema — User memory (PostgreSQL).
 *
 * Tables: user_memories
 *
 * Stores persistent user-specific facts learned from conversations.
 * Categories: preference (style), fact (role/tech), behavior (patterns).
 * Memory extraction runs as a daily scheduled job.
 */

import { pgTable, serial, text, timestamp, integer, doublePrecision, index } from 'drizzle-orm/pg-core';
import { users } from './user.js';

// ─── user_memories ────────────────────────────────────────

export const userMemories = pgTable(
  'user_memories',
  {
    id: serial('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    category: text('category').notNull().default('preference'),
    // 'preference' — 回答风格、语言、格式偏好
    // 'fact'       — 角色、项目、技术栈
    // 'behavior'   — 常用工具、工作流习惯
    content: text('content').notNull(),
    source_session_id: text('source_session_id'),
    confidence: doublePrecision('confidence').notNull().default(0.8),
    access_count: integer('access_count').notNull().default(0),
    last_accessed_at: timestamp('last_accessed_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_user_memories_user').on(table.user_id),
    index('idx_user_memories_category').on(table.user_id, table.category),
  ],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type UserMemoryRow = typeof userMemories.$inferSelect;
