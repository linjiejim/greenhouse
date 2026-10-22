/**
 * Drizzle schema — retired tables.
 *
 * Retired in v1.4: no code reads or writes these tables; they stay so a blue/green
 * rollback to v1.3.x keeps working, and are dropped in the release after v1.4.
 *
 * Keep each definition byte-for-byte what v1.3 shipped (the Drizzle snapshot must not
 * change), and never import these exports from application code.
 */

import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  bigint,
  doublePrecision,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './user.js';

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

// ═══ Missions (cloud-agent sandbox runs) ═══

// ─── agent_workspaces ────────────────────────────────────

export const agentWorkspaces = pgTable(
  'agent_workspaces',
  {
    id: serial('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** archived = tarball on COS (cos_archive_key), local dir reclaimed. */
    status: text('status', { enum: ['active', 'archived'] })
      .notNull()
      .default('active'),
    /** Last measured on-disk size (bytes); node_modules etc. included. */
    disk_bytes: bigint('disk_bytes', { mode: 'number' }).notNull().default(0),
    cos_archive_key: text('cos_archive_key'),
    last_used_at: timestamp('last_used_at', { withTimezone: true, mode: 'string' }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_agent_workspaces_user').on(table.user_id)],
);

// ─── agent_runs ──────────────────────────────────────────

export const agentRuns = pgTable(
  'agent_runs',
  {
    /** `car_<hex>` — generated by the service, also the workspace dir name. */
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspace_id: integer('workspace_id')
      .notNull()
      .references(() => agentWorkspaces.id, { onDelete: 'cascade' }),
    // TS-level enum only (pg `text` emits no CHECK), so adding a status needs no migration.
    status: text('status', { enum: ['queued', 'starting', 'running', 'completed', 'failed', 'canceled'] })
      .notNull()
      .default('queued'),
    /** Stable identity of a Mission Dispatch card; null for standalone runs. */
    dispatch_id: text('dispatch_id'),
    title: text('title').notNull(),
    /** Exact user-authored instruction, never decorated for the runner. */
    original_prompt: text('original_prompt').notNull(),
    /** Runner-facing prompt, including structured attachment guidance. */
    prompt: text('prompt').notNull(),
    /** Frozen attachment/input metadata JSON for audit and replay. */
    input_manifest: text('input_manifest').notNull().default('[]'),
    /** Model registry id (config/models.yaml), e.g. 'flash'. */
    model: text('model').notNull(),
    /** Registry id the runner downgrades to on upstream 429/quota exhaustion. */
    fallback_model: text('fallback_model'),
    /** Docker container id once started (boot sweep reconciles against it). */
    container_id: text('container_id'),
    /** Per-run relay api_clients.id (logical relation, no FK — see header). */
    relay_client_id: text('relay_client_id'),
    /**
     * Chat session this run converses through (channel='mission'; logical
     * relation, no FK — deleting the conversation keeps the run audit).
     */
    session_id: text('session_id'),
    /** Wall-clock budget; also the task token TTL. */
    max_wall_ms: integer('max_wall_ms').notNull().default(7_200_000),
    /** LLM request budget (provider quota is deployment-shared). */
    max_requests: integer('max_requests').notNull().default(300),
    used_requests: integer('used_requests').notNull().default(0),
    input_tokens: integer('input_tokens').notNull().default(0),
    output_tokens: integer('output_tokens').notNull().default(0),
    result_summary: text('result_summary'),
    /** Stable machine-readable failure reason rendered by the web. */
    failure_code: text('failure_code'),
    error: text('error'),
    /** Object-storage key of the archived runner journal. */
    journal_storage_key: text('journal_storage_key'),
    queued_at: timestamp('queued_at', { withTimezone: true, mode: 'string' }).notNull(),
    started_at: timestamp('started_at', { withTimezone: true, mode: 'string' }),
    ended_at: timestamp('ended_at', { withTimezone: true, mode: 'string' }),
    /** Terminal cleanup/outbox/journal reconciliation completed. */
    settled_at: timestamp('settled_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_agent_runs_user').on(table.user_id),
    index('idx_agent_runs_status').on(table.status),
    index('idx_agent_runs_workspace').on(table.workspace_id),
    index('idx_agent_runs_session').on(table.session_id),
    uniqueIndex('uq_agent_runs_dispatch').on(table.dispatch_id),
  ],
);

// ─── agent_run_events ────────────────────────────────────

export const agentRunEvents = pgTable(
  'agent_run_events',
  {
    id: serial('id').primaryKey(),
    run_id: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    /**
     * Runner-assigned, per-run monotonic. The unique index makes event
     * ingestion idempotent (the runner retries pushes after api restarts);
     * the web polls `seq > after` for incremental replay.
     */
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    /** Exact step-level event payload JSON; permanent and never auto-truncated. */
    payload: text('payload').notNull().default('{}'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_agent_run_events_run_seq').on(table.run_id, table.seq),
    index('idx_agent_run_events_run').on(table.run_id),
  ],
);

// ─── agent_artifacts ─────────────────────────────────────

export const agentArtifacts = pgTable(
  'agent_artifacts',
  {
    id: serial('id').primaryKey(),
    run_id: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    /** Path relative to /workspace/artifacts inside the container. */
    path: text('path').notNull(),
    size_bytes: integer('size_bytes').notNull(),
    content_type: text('content_type').notNull().default('application/octet-stream'),
    sha256: text('sha256').notNull(),
    /** Upload storage key (COS or local fallback — storage/uploads.ts). */
    storage_key: text('storage_key').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_agent_artifacts_run').on(table.run_id)],
);

// ─── agent_run_approvals ────────────────────────────────

export const agentRunApprovals = pgTable(
  'agent_run_approvals',
  {
    /** `caa_<hex>` — one exact, single-use mutation approval lease. */
    id: text('id').primaryKey(),
    run_id: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tool_id: text('tool_id').notNull(),
    action: text('action'),
    input_hash: text('input_hash').notNull(),
    input_json: text('input_json').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'denied', 'consumed', 'expired'] })
      .notNull()
      .default('pending'),
    expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    decided_by: text('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decided_at: timestamp('decided_at', { withTimezone: true, mode: 'string' }),
    consumed_at: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_agent_run_approvals_run_status').on(table.run_id, table.status),
    index('idx_agent_run_approvals_user_status').on(table.user_id, table.status),
  ],
);

// ─── agent_run_outbox ───────────────────────────────────

export const agentRunOutbox = pgTable(
  'agent_run_outbox',
  {
    /** One frozen outcome per run. */
    run_id: text('run_id')
      .primaryKey()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    session_id: text('session_id').notNull(),
    message_id: text('message_id').notNull(),
    content: text('content').notNull(),
    status: text('status', { enum: ['pending', 'delivered'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    last_error: text('last_error'),
    delivered_at: timestamp('delivered_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_agent_run_outbox_status').on(table.status, table.created_at)],
);

// ═══ LLM relay keys (the `/api/llm` gateway; Mission per-run keys) ═══
// `api_audit_log` is NOT retired: MCP and the Agent proxy still write it (schema/api-audit.ts).

// ─── api_clients ──────────────────────────────────────────

export const apiClients = pgTable(
  'api_clients',
  {
    id: text('id').primaryKey(),
    app_id: text('app_id').notNull().unique(),
    app_name: text('app_name').notNull(),
    api_key_hash: text('api_key_hash').notNull(),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    rate_limit_rpm: integer('rate_limit_rpm').notNull().default(60),
    rate_limit_rpd: integer('rate_limit_rpd').notNull().default(1000),
    daily_token_limit: integer('daily_token_limit').notNull().default(1000000),
    meta: text('meta').notNull().default('{}'),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: ['a2a', 'relay'] })
      .notNull()
      .default('a2a'),
    created_by: text('created_by'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_api_clients_user').on(table.user_id)],
);
