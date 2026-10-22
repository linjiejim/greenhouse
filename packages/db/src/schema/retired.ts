/**
 * Drizzle schema — retired tables.
 *
 * Retired in v1.4: no code reads or writes these tables; they stay so a blue/green
 * rollback to v1.3.x keeps working, and are dropped in the release after v1.4.
 *
 * Keep each definition byte-for-byte what v1.3 shipped (the Drizzle snapshot must not
 * change), and never import these exports from application code.
 */

import { pgTable, text, serial, timestamp, integer, doublePrecision, index } from 'drizzle-orm/pg-core';

// ═══ Evaluation (eval datasets / runs / results, per-answer judge) ═══

// ─── eval_datasets ────────────────────────────────────────

export const evalDatasets = pgTable('eval_datasets', {
  id: serial('id').primaryKey(),
  category: text('category').notNull(),
  difficulty: text('difficulty').notNull().default('medium'),
  question: text('question').notNull(),
  ground_truth: text('ground_truth').notNull(),
  expected_behavior: text('expected_behavior'),
  tags: text('tags').notNull().default('[]'),
  language: text('language').notNull().default('en'),
  is_negative: integer('is_negative').notNull().default(0),
  enabled: integer('enabled').notNull().default(1),
  // ─── New management fields ────────────────────
  created_by: text('created_by'),
  updated_by: text('updated_by'),
  source: text('source').notNull().default('manual'),
  source_session_id: text('source_session_id'),
  status: text('status').notNull().default('active'),
  notes: text('notes'),
  archived_at: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
  // ──────────────────────────────────────────────
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
});

// ─── eval_runs ────────────────────────────────────────────

export const evalRuns = pgTable('eval_runs', {
  id: text('id').primaryKey(),
  name: text('name'),
  status: text('status').notNull().default('running'),
  total: integer('total').notNull().default(0),
  completed: integer('completed').notNull().default(0),
  passed: integer('passed').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  avg_score: doublePrecision('avg_score'),
  avg_accuracy: doublePrecision('avg_accuracy'),
  avg_completeness: doublePrecision('avg_completeness'),
  avg_relevance: doublePrecision('avg_relevance'),
  avg_speed: doublePrecision('avg_speed'),
  model: text('model'),
  profile_id: text('profile_id').notNull().default('team'),
  config: text('config').notNull().default('{}'),
  started_at: timestamp('started_at', { withTimezone: true, mode: 'string' }).notNull(),
  finished_at: timestamp('finished_at', { withTimezone: true, mode: 'string' }),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
});

// ─── eval_results ─────────────────────────────────────────

export const evalResults = pgTable(
  'eval_results',
  {
    id: serial('id').primaryKey(),
    run_id: text('run_id')
      .notNull()
      .references(() => evalRuns.id, { onDelete: 'cascade' }),
    dataset_id: integer('dataset_id')
      .notNull()
      .references(() => evalDatasets.id),
    session_id: text('session_id'),
    answer: text('answer'),
    references_used: text('references_used').notNull().default('[]'),
    duration_ms: integer('duration_ms'),
    ttfb_ms: integer('ttfb_ms'),
    answer_length: integer('answer_length'),
    score_accuracy: doublePrecision('score_accuracy'),
    score_completeness: doublePrecision('score_completeness'),
    score_relevance: doublePrecision('score_relevance'),
    score_speed: doublePrecision('score_speed'),
    score_final: doublePrecision('score_final'),
    judge_reasoning: text('judge_reasoning'),
    status: text('status').notNull().default('pending'),
    error: text('error'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_eval_results_run').on(table.run_id), index('idx_eval_results_dataset').on(table.dataset_id)],
);

// ─── chat_eval_results ────────────────────────────────────

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
