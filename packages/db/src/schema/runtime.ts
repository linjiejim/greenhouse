/**
 * Drizzle schema — trusted Runtime control plane (PostgreSQL).
 *
 * Runtime is the canonical execution envelope shared by Chat, Automation,
 * Workflow, Mission, Subagent and Eval. Domain tables remain the source of
 * their own graph/workspace/transcript facts while these rows provide one
 * durable lifecycle, lease, interrupt and delivery protocol.
 *
 * Payload columns deliberately store complete JSON-as-text and have no TTL.
 * Actor/session/source/audit identifiers are logical references so execution
 * history survives deletion in another domain. Strong ownership inside one
 * Runtime run uses FK CASCADE.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// ─── Runs ───────────────────────────────────────────────

export const runtimeRuns = pgTable(
  'runtime_runs',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['chat', 'automation', 'workflow', 'mission', 'subagent', 'eval'] }).notNull(),
    /** Logical user references: permanent execution history must outlive users. */
    owner_user_id: text('owner_user_id').notNull(),
    initiated_by_user_id: text('initiated_by_user_id').notNull(),
    /** Logical session reference: deleting a conversation must not erase a run. */
    session_id: text('session_id'),
    /** Parent ownership is strong; deleting an explicitly removed root clears its tree. */
    parent_run_id: text('parent_run_id').references((): AnyPgColumn => runtimeRuns.id, {
      onDelete: 'cascade',
    }),
    /** Root runs point root_run_id to their own id; this lineage lookup is logical. */
    root_run_id: text('root_run_id').notNull(),
    /** Logical link to the domain fact (agent_runs/workflow_runs/etc.). */
    source_kind: text('source_kind').notNull(),
    source_id: text('source_id').notNull(),
    idempotency_key: text('idempotency_key'),
    status: text('status', {
      enum: ['queued', 'claimed', 'running', 'waiting', 'paused', 'succeeded', 'failed', 'canceled', 'interrupted'],
    })
      .notNull()
      .default('queued'),
    desired_state: text('desired_state', { enum: ['run', 'pause', 'cancel'] })
      .notNull()
      .default('run'),
    wait_reason: text('wait_reason'),
    priority: integer('priority').notNull().default(0),
    not_before: timestamp('not_before', { withTimezone: true, mode: 'string' }),
    deadline_at: timestamp('deadline_at', { withTimezone: true, mode: 'string' }),
    lease_owner: text('lease_owner'),
    lease_expires_at: timestamp('lease_expires_at', { withTimezone: true, mode: 'string' }),
    heartbeat_at: timestamp('heartbeat_at', { withTimezone: true, mode: 'string' }),
    attempt: integer('attempt').notNull().default(0),
    max_attempts: integer('max_attempts').notNull().default(3),
    input: text('input').notNull().default('{}'),
    output: text('output'),
    error_code: text('error_code'),
    error_message: text('error_message'),
    started_at: timestamp('started_at', { withTimezone: true, mode: 'string' }),
    ended_at: timestamp('ended_at', { withTimezone: true, mode: 'string' }),
    settled_at: timestamp('settled_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    uniqueIndex('uq_runtime_runs_source').on(table.kind, table.source_kind, table.source_id),
    uniqueIndex('uq_runtime_runs_owner_idempotency')
      .on(table.owner_user_id, table.kind, table.idempotency_key)
      .where(sql`${table.idempotency_key} IS NOT NULL`),
    index('idx_runtime_runs_owner_created').on(table.owner_user_id, table.created_at),
    index('idx_runtime_runs_root').on(table.root_run_id),
    index('idx_runtime_runs_parent').on(table.parent_run_id),
    index('idx_runtime_runs_claim').on(table.status, table.desired_state, table.not_before, table.priority),
    index('idx_runtime_runs_stale_lease').on(table.status, table.lease_expires_at),
    check('chk_runtime_runs_attempts', sql`${table.attempt} >= 0 AND ${table.max_attempts} > 0`),
    check('chk_runtime_runs_version', sql`${table.version} > 0`),
  ],
);

// ─── Steps ──────────────────────────────────────────────

export const runtimeSteps = pgTable(
  'runtime_steps',
  {
    id: text('id').primaryKey(),
    run_id: text('run_id')
      .notNull()
      .references(() => runtimeRuns.id, { onDelete: 'cascade' }),
    parent_step_id: text('parent_step_id').references((): AnyPgColumn => runtimeSteps.id, {
      onDelete: 'set null',
    }),
    step_key: text('step_key').notNull(),
    kind: text('kind').notNull(),
    attempt: integer('attempt').notNull().default(1),
    status: text('status', {
      enum: [
        'queued',
        'claimed',
        'running',
        'waiting',
        'paused',
        'succeeded',
        'failed',
        'canceled',
        'interrupted',
        'skipped',
      ],
    })
      .notNull()
      .default('queued'),
    lease_owner: text('lease_owner'),
    lease_expires_at: timestamp('lease_expires_at', { withTimezone: true, mode: 'string' }),
    heartbeat_at: timestamp('heartbeat_at', { withTimezone: true, mode: 'string' }),
    input: text('input').notNull().default('{}'),
    output: text('output'),
    error_code: text('error_code'),
    error_message: text('error_message'),
    tokens_used: bigint('tokens_used', { mode: 'number' }).notNull().default(0),
    requests_used: bigint('requests_used', { mode: 'number' }).notNull().default(0),
    cost_micros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
    duration_ms: bigint('duration_ms', { mode: 'number' }),
    started_at: timestamp('started_at', { withTimezone: true, mode: 'string' }),
    ended_at: timestamp('ended_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    uniqueIndex('uq_runtime_steps_run_key_attempt').on(table.run_id, table.step_key, table.attempt),
    index('idx_runtime_steps_run_created').on(table.run_id, table.created_at),
    index('idx_runtime_steps_parent').on(table.parent_step_id),
    index('idx_runtime_steps_claim').on(table.status, table.lease_expires_at),
    check('chk_runtime_steps_attempt', sql`${table.attempt} > 0`),
    check(
      'chk_runtime_steps_usage',
      sql`${table.tokens_used} >= 0 AND ${table.requests_used} >= 0 AND ${table.cost_micros} >= 0 AND (${table.duration_ms} IS NULL OR ${table.duration_ms} >= 0)`,
    ),
    check('chk_runtime_steps_version', sql`${table.version} > 0`),
  ],
);

// ─── Tool calls ─────────────────────────────────────────

export const runtimeToolCalls = pgTable(
  'runtime_tool_calls',
  {
    id: text('id').primaryKey(),
    run_id: text('run_id')
      .notNull()
      .references(() => runtimeRuns.id, { onDelete: 'cascade' }),
    step_id: text('step_id').references(() => runtimeSteps.id, { onDelete: 'set null' }),
    tool_name: text('tool_name').notNull(),
    status: text('status', {
      enum: ['pending', 'awaiting_approval', 'running', 'succeeded', 'failed', 'canceled', 'uncertain'],
    })
      .notNull()
      .default('pending'),
    input: text('input').notNull().default('{}'),
    output: text('output'),
    canonical_input_hash: text('canonical_input_hash').notNull(),
    risk_level: text('risk_level', { enum: ['r0', 'r1', 'r2', 'r3'] }).notNull(),
    idempotency_key: text('idempotency_key'),
    /** Logical backlink: interrupts already strongly reference this row. */
    interrupt_id: text('interrupt_id'),
    /** Logical link to permanent Platform authorization audit. */
    platform_audit_event_id: text('platform_audit_event_id'),
    error_code: text('error_code'),
    error_message: text('error_message'),
    started_at: timestamp('started_at', { withTimezone: true, mode: 'string' }),
    ended_at: timestamp('ended_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    index('idx_runtime_tool_calls_run_created').on(table.run_id, table.created_at),
    index('idx_runtime_tool_calls_step').on(table.step_id),
    index('idx_runtime_tool_calls_interrupt').on(table.interrupt_id),
    uniqueIndex('uq_runtime_tool_calls_run_idempotency')
      .on(table.run_id, table.idempotency_key)
      .where(sql`${table.idempotency_key} IS NOT NULL`),
    check('chk_runtime_tool_calls_version', sql`${table.version} > 0`),
  ],
);

// ─── Artifacts ──────────────────────────────────────────

export const runtimeArtifacts = pgTable(
  'runtime_artifacts',
  {
    id: text('id').primaryKey(),
    run_id: text('run_id')
      .notNull()
      .references(() => runtimeRuns.id, { onDelete: 'cascade' }),
    step_id: text('step_id').references(() => runtimeSteps.id, { onDelete: 'set null' }),
    tool_call_id: text('tool_call_id').references(() => runtimeToolCalls.id, { onDelete: 'set null' }),
    direction: text('direction', { enum: ['input', 'output'] }).notNull(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    path: text('path'),
    content_type: text('content_type'),
    size_bytes: bigint('size_bytes', { mode: 'number' }),
    sha256: text('sha256'),
    storage_key: text('storage_key'),
    status: text('status', { enum: ['pending', 'available', 'failed', 'skipped'] })
      .notNull()
      .default('pending'),
    source: text('source').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_runtime_artifacts_run_created').on(table.run_id, table.created_at),
    index('idx_runtime_artifacts_step').on(table.step_id),
    index('idx_runtime_artifacts_tool').on(table.tool_call_id),
    check('chk_runtime_artifacts_size', sql`${table.size_bytes} IS NULL OR ${table.size_bytes} >= 0`),
  ],
);

// ─── Interrupts ─────────────────────────────────────────

export const runtimeInterrupts = pgTable(
  'runtime_interrupts',
  {
    id: text('id').primaryKey(),
    run_id: text('run_id')
      .notNull()
      .references(() => runtimeRuns.id, { onDelete: 'cascade' }),
    step_id: text('step_id').references(() => runtimeSteps.id, { onDelete: 'set null' }),
    tool_call_id: text('tool_call_id').references(() => runtimeToolCalls.id, { onDelete: 'set null' }),
    kind: text('kind', {
      enum: [
        'mutation_approval',
        'workflow_gate',
        'ask_user',
        'credential_required',
        'budget_exceeded',
        'external_dependency',
        'outcome_unknown',
        'manual_pause',
      ],
    }).notNull(),
    status: text('status', { enum: ['pending', 'resolved', 'rejected', 'expired', 'canceled'] })
      .notNull()
      .default('pending'),
    payload: text('payload').notNull().default('{}'),
    canonical_input_hash: text('canonical_input_hash'),
    risk_level: text('risk_level', { enum: ['r0', 'r1', 'r2', 'r3'] }),
    /** Logical user references: the decision record must survive account deletion. */
    assignee_user_id: text('assignee_user_id').notNull(),
    expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
    decision: text('decision'),
    decided_by_user_id: text('decided_by_user_id'),
    decided_at: timestamp('decided_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    index('idx_runtime_interrupts_run_created').on(table.run_id, table.created_at),
    index('idx_runtime_interrupts_assignee_pending').on(table.assignee_user_id, table.status, table.created_at),
    index('idx_runtime_interrupts_step').on(table.step_id),
    index('idx_runtime_interrupts_tool').on(table.tool_call_id),
    check('chk_runtime_interrupts_version', sql`${table.version} > 0`),
  ],
);

// ─── Append-only event log ──────────────────────────────

export const runtimeEvents = pgTable(
  'runtime_events',
  {
    id: text('id').primaryKey(),
    run_id: text('run_id')
      .notNull()
      .references(() => runtimeRuns.id, { onDelete: 'cascade' }),
    /** Logical step reference keeps the exact historical identifier. */
    step_id: text('step_id'),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    type: text('type').notNull(),
    payload: text('payload').notNull().default('{}'),
    actor_user_id: text('actor_user_id'),
    idempotency_key: text('idempotency_key'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_runtime_events_run_seq').on(table.run_id, table.seq),
    uniqueIndex('uq_runtime_events_run_idempotency')
      .on(table.run_id, table.idempotency_key)
      .where(sql`${table.idempotency_key} IS NOT NULL`),
    index('idx_runtime_events_run_created').on(table.run_id, table.created_at),
    index('idx_runtime_events_step').on(table.step_id),
    check('chk_runtime_events_seq', sql`${table.seq} > 0`),
  ],
);

// ─── Transactional outbox ───────────────────────────────

export const runtimeOutbox = pgTable(
  'runtime_outbox',
  {
    id: text('id').primaryKey(),
    event_id: text('event_id')
      .notNull()
      .references(() => runtimeEvents.id, { onDelete: 'cascade' }),
    topic: text('topic').notNull(),
    payload: text('payload').notNull().default('{}'),
    status: text('status', { enum: ['pending', 'claimed', 'delivered', 'failed', 'dead_letter'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    max_attempts: integer('max_attempts').notNull().default(10),
    available_at: timestamp('available_at', { withTimezone: true, mode: 'string' }).notNull(),
    lease_owner: text('lease_owner'),
    lease_expires_at: timestamp('lease_expires_at', { withTimezone: true, mode: 'string' }),
    last_error: text('last_error'),
    delivered_at: timestamp('delivered_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    uniqueIndex('uq_runtime_outbox_event_topic').on(table.event_id, table.topic),
    index('idx_runtime_outbox_delivery').on(table.status, table.available_at, table.lease_expires_at),
    check('chk_runtime_outbox_attempts', sql`${table.attempts} >= 0 AND ${table.max_attempts} > 0`),
    check('chk_runtime_outbox_version', sql`${table.version} > 0`),
  ],
);

// ─── Row types (schema is the single source of truth) ──

export type RuntimeRunRow = typeof runtimeRuns.$inferSelect;
export type RuntimeRunKind = RuntimeRunRow['kind'];
export type RuntimeRunStatus = RuntimeRunRow['status'];
export type RuntimeDesiredState = RuntimeRunRow['desired_state'];
export type RuntimeStepRow = typeof runtimeSteps.$inferSelect;
export type RuntimeStepStatus = RuntimeStepRow['status'];
export type RuntimeToolCallRow = typeof runtimeToolCalls.$inferSelect;
export type RuntimeToolCallStatus = RuntimeToolCallRow['status'];
export type RuntimeActionRisk = RuntimeToolCallRow['risk_level'];
export type RuntimeArtifactRow = typeof runtimeArtifacts.$inferSelect;
export type RuntimeArtifactStatus = RuntimeArtifactRow['status'];
export type RuntimeInterruptRow = typeof runtimeInterrupts.$inferSelect;
export type RuntimeInterruptStatus = RuntimeInterruptRow['status'];
export type RuntimeEventRow = typeof runtimeEvents.$inferSelect;
export type RuntimeOutboxRow = typeof runtimeOutbox.$inferSelect;
export type RuntimeOutboxStatus = RuntimeOutboxRow['status'];
