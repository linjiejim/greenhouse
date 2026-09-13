/**
 * Drizzle schema — Chat Eval Results table (PostgreSQL).
 *
 * Tables: chat_eval_results
 */

import { pgTable, text, serial, timestamp, integer, doublePrecision, index } from 'drizzle-orm/pg-core';

export const chatEvalResults = pgTable(
  'chat_eval_results',
  {
    id: serial('id').primaryKey(),
    message_id: text('message_id').notNull().unique(),
    session_id: text('session_id').notNull(),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    // ── 问答评测 v2 (type-aware, verdict + 4 quality dims) ──
    /** 'pass' | 'fail' | 'pending'. */
    verdict: text('verdict'),
    /** Weighted 0–10; null when verdict is 'pending'. */
    score_final: doublePrecision('score_final'),
    /** JSON: { reply_class, intent_summary, q_type_l1, q_type_l2 }. */
    classification: text('classification').notNull().default('{}'),
    /** JSON: { kb_consistency, citation_correctness, boundary_control, safety } → {score,reason}. */
    dimensions: text('dimensions').notNull().default('{}'),
    /** JSON: { consistent, added, rewritten, omitted, unsupported }: string[]. */
    consistency_detail: text('consistency_detail').notNull().default('{}'),
    /** JSON CitationIssue[]. */
    citation_issues: text('citation_issues').notNull().default('[]'),
    /** JSON string[] — actionable fixes. */
    suggestions: text('suggestions').notNull().default('[]'),
    /** Full raw judge result JSON (audit/debug). */
    judge_reasoning: text('judge_reasoning'),
    references_checked: text('references_checked').notNull().default('[]'),
    // ── Legacy v1 columns (4 fixed dims) — kept nullable for back-compat, no longer written ──
    score_accuracy: doublePrecision('score_accuracy'),
    score_faithfulness: doublePrecision('score_faithfulness'),
    score_completeness: doublePrecision('score_completeness'),
    score_hallucination: doublePrecision('score_hallucination'),
    discrepancies: text('discrepancies').notNull().default('[]'),
    duration_ms: integer('duration_ms'),
    input_tokens: integer('input_tokens'),
    output_tokens: integer('output_tokens'),
    eval_session_id: text('eval_session_id'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_chat_eval_message').on(table.message_id), index('idx_chat_eval_session').on(table.session_id)],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type ChatEvalResultRow = typeof chatEvalResults.$inferSelect;
