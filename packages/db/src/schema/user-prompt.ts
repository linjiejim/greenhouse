/**
 * Drizzle schema — Tasks (reusable prompts, slash-invoked).
 *
 * Tables: user_prompts
 *
 * The table keeps its original name: a Task IS a prompt, with optional
 * parameters and a record of which tools the captured flow used. A row with an
 * empty `variables` and `expected_tools` behaves exactly as prompts always did,
 * which is why this evolved in place rather than growing a second table
 * (spec 20260808-tasks-from-sessions, D1).
 */

import { pgTable, serial, text, timestamp, integer, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';

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
    /** One line on what this task is for; shown in the picker. */
    description: text('description'),
    /** JSON `TaskVariable[]` — `{{key}}` placeholders the body expects. */
    variables: text('variables').notNull().default('[]'),
    /**
     * JSON `string[]` of tool ids the captured run actually used.
     *
     * DISPLAY ONLY — it answers "what can this task reach", not "what may this
     * user run". Enforcement stays with the existing per-user tool resolution;
     * a second gate here would just misfire when the author has a tool the
     * runner does not (spec D4).
     */
    expected_tools: text('expected_tools').notNull().default('[]'),
    /** The conversation this was distilled from. Logical ref, no FK — a task outlives its session. */
    source_session_id: text('source_session_id'),
    /** Stable chat-card action id. Null for manually authored Tasks. */
    artifact_action_id: text('artifact_action_id'),
    created_via: text('created_via', { enum: ['manual', 'capture'] })
      .notNull()
      .default('manual'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_user_prompts_user').on(table.user_id),
    uniqueIndex('uq_user_prompts_artifact_action').on(table.artifact_action_id),
  ],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type UserPromptRow = typeof userPrompts.$inferSelect;
