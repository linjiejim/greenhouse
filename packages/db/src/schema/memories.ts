/**
 * Per-member agent memory. The lifecycle is a state machine and `status` is
 * the truth: active (in the injected index) → dormant (90 days unused; still
 * searchable, recall revives it) → archived / superseded (`superseded_by`
 * points at the replacement). Only the member's own delete removes a row.
 *
 * Tables: memories
 */

import { boolean, index, pgTable, text, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { at, createdAt, id, oneOf, updatedAt } from './_columns.js';
import { users } from './identity.js';

export const MEMORY_CATEGORIES = ['preference', 'fact', 'behavior'] as const;
export const MEMORY_STATUSES = ['active', 'dormant', 'archived', 'superseded'] as const;
export const MEMORY_SOURCES = ['user', 'agent', 'consolidation'] as const;

export const memories = pgTable(
  'memories',
  {
    id: id(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    category: text('category', { enum: MEMORY_CATEGORIES }).notNull().default('preference'),
    /** The recall index entry — the only part that enters the prompt. */
    title: text('title').notNull(),
    content: text('content').notNull(),
    status: text('status', { enum: MEMORY_STATUSES }).notNull().default('active'),
    pinned: boolean('pinned').notNull().default(false),
    source: text('source', { enum: MEMORY_SOURCES }).notNull().default('agent'),
    superseded_by: text('superseded_by').references((): AnyPgColumn => memories.id, { onDelete: 'set null' }),
    source_session_id: text('source_session_id'),
    last_used_at: at('last_used_at'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    index('idx_memories_user_status').on(table.user_id, table.status),
    index('idx_memories_user_category').on(table.user_id, table.category),
    oneOf('chk_memories_category', table.category, MEMORY_CATEGORIES),
    oneOf('chk_memories_status', table.status, MEMORY_STATUSES),
    oneOf('chk_memories_source', table.source, MEMORY_SOURCES),
  ],
);

export type UserMemoryRow = typeof memories.$inferSelect;
export type UserMemoryCategory = UserMemoryRow['category'];
export type UserMemoryStatus = UserMemoryRow['status'];
export type UserMemorySource = UserMemoryRow['source'];
