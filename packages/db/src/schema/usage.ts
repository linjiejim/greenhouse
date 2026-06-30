/**
 * Drizzle schema — LLM Usage tracking table (PostgreSQL).
 *
 * Tables: llm_usage
 */

import { pgTable, text, serial, timestamp, integer, index } from 'drizzle-orm/pg-core';

export const llmUsage = pgTable(
  'llm_usage',
  {
    id: serial('id').primaryKey(),
    profile_id: text('profile_id').notNull(),
    caller: text('caller').notNull().default(''),
    session_id: text('session_id'),
    user_id: text('user_id'),
    model: text('model').notNull(),
    input_tokens: integer('input_tokens').notNull().default(0),
    output_tokens: integer('output_tokens').notNull().default(0),
    cached_tokens: integer('cached_tokens').notNull().default(0),
    reasoning_tokens: integer('reasoning_tokens').notNull().default(0),
    duration_ms: integer('duration_ms'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_llm_usage_profile').on(table.profile_id),
    index('idx_llm_usage_created').on(table.created_at),
    index('idx_llm_usage_caller').on(table.caller),
    index('idx_llm_usage_user').on(table.user_id),
  ],
);
