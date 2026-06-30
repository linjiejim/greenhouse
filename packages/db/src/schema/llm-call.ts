/**
 * Drizzle schema — LLM Call audit table (PostgreSQL).
 *
 * Tables: llm_calls
 *
 * Records every `call_llm` tool invocation: the full prompt + output of a
 * one-shot, tool-less LLM sub-call made from within a session. Kept in its own
 * table (not as session messages) so the full input/output is durably auditable
 * and retrospectable WITHOUT being reloaded into the calling session's context.
 */

import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { sessions } from './session.js';

export const llmCalls = pgTable(
  'llm_calls',
  {
    id: text('id').primaryKey(),
    // The session whose agent issued this call. Cascades so audit rows die with
    // the session they belong to.
    session_id: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    user_id: text('user_id'),
    model: text('model').notNull(),
    system: text('system'),
    input: text('input').notNull(),
    output: text('output'),
    status: text('status').notNull().default('ok'), // 'ok' | 'error'
    error: text('error'),
    input_tokens: integer('input_tokens'),
    output_tokens: integer('output_tokens'),
    duration_ms: integer('duration_ms'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_llm_calls_session').on(table.session_id)],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type LlmCallRow = typeof llmCalls.$inferSelect;
