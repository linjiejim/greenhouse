/**
 * Saved prompts: a member's own, or global ones a super publishes.
 *
 * Tables: prompts
 */

import { boolean, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, id, json, oneOf, updatedAt } from './_columns.js';

export const PROMPT_CREATED_VIA = ['manual', 'capture'] as const;

export const prompts = pgTable(
  'prompts',
  {
    id: id(),
    user_id: text('user_id').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    shortcut: text('shortcut'),
    sort_order: integer('sort_order').notNull().default(0),
    is_global: boolean('is_global').notNull().default(false),
    description: text('description'),
    variables: json<unknown[]>('variables', []),
    expected_tools: json<string[]>('expected_tools', []),
    source_session_id: text('source_session_id'),
    artifact_action_id: text('artifact_action_id'),
    created_via: text('created_via', { enum: PROMPT_CREATED_VIA }).notNull().default('manual'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    index('idx_prompts_user').on(table.user_id),
    uniqueIndex('uq_prompts_artifact_action').on(table.artifact_action_id),
    oneOf('chk_prompts_created_via', table.created_via, PROMPT_CREATED_VIA),
  ],
);

export type UserPromptRow = typeof prompts.$inferSelect;
