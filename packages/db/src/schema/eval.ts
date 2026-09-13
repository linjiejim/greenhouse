/**
 * Drizzle schema — Eval tables (PostgreSQL).
 *
 * Tables: eval_datasets, eval_runs, eval_results
 */

import { pgTable, text, serial, timestamp, integer, doublePrecision, index } from 'drizzle-orm/pg-core';

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
