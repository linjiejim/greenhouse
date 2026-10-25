/**
 * Runs: the unified execution kernel (envelope, leases / CAS, interrupts,
 * events and their transactional outbox).
 *
 * Tables: runs, run_steps, run_tool_calls, run_interrupts, run_events, run_outbox
 *
 * Users, conversations, sources and audit rows are logical references so
 * execution history outlives them. Retention: run events of settled runs are
 * kept 30 days, delivered outbox rows 7 days (`retention.ts`). Files a run
 * produced live in `files` (source = 'run').
 */

import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, text, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { at, createdAt, id, json, jsonOrNull, oneOf, updatedAt } from './_columns.js';

/** Stored runtime JSON (input / output / payload / decision). */
export type RuntimeJson = unknown;

export const RUN_KINDS = [
  'chat',
  'automation',
  'workflow',
  'mission',
  'subagent',
  'eval',
  'agent_write',
  'connector_write',
] as const;
export const RUN_STATUSES = [
  'queued',
  'claimed',
  'running',
  'waiting',
  'paused',
  'succeeded',
  'failed',
  'canceled',
  'interrupted',
] as const;
export const TERMINAL_RUN_STATUSES = ['succeeded', 'failed', 'canceled', 'interrupted'] as const;
export const RUN_DESIRED_STATES = ['run', 'pause', 'cancel'] as const;
export const RISK_LEVELS = ['r0', 'r1', 'r2', 'r3'] as const;

export const runs = pgTable(
  'runs',
  {
    id: id(),
    kind: text('kind', { enum: RUN_KINDS }).notNull(),
    owner_user_id: text('owner_user_id').notNull(),
    initiated_by_user_id: text('initiated_by_user_id').notNull(),
    session_id: text('session_id'),
    parent_run_id: text('parent_run_id').references((): AnyPgColumn => runs.id, { onDelete: 'cascade' }),
    root_run_id: text('root_run_id').notNull(),
    source_kind: text('source_kind').notNull(),
    source_id: text('source_id').notNull(),
    idempotency_key: text('idempotency_key'),
    status: text('status', { enum: RUN_STATUSES }).notNull().default('queued'),
    desired_state: text('desired_state', { enum: RUN_DESIRED_STATES }).notNull().default('run'),
    wait_reason: text('wait_reason'),
    priority: integer('priority').notNull().default(0),
    not_before: at('not_before'),
    deadline_at: at('deadline_at'),
    lease_owner: text('lease_owner'),
    lease_expires_at: at('lease_expires_at'),
    heartbeat_at: at('heartbeat_at'),
    attempt: integer('attempt').notNull().default(0),
    max_attempts: integer('max_attempts').notNull().default(3),
    input: json<RuntimeJson>('input', {}),
    output: jsonOrNull<RuntimeJson>('output'),
    error_code: text('error_code'),
    error_message: text('error_message'),
    started_at: at('started_at'),
    ended_at: at('ended_at'),
    settled_at: at('settled_at'),
    created_at: createdAt(),
    updated_at: updatedAt(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    uniqueIndex('uq_runs_source').on(table.kind, table.source_kind, table.source_id),
    uniqueIndex('uq_runs_owner_idempotency')
      .on(table.owner_user_id, table.kind, table.idempotency_key)
      .where(sql`${table.idempotency_key} IS NOT NULL`),
    index('idx_runs_owner_created').on(table.owner_user_id, table.created_at),
    index('idx_runs_session').on(table.session_id),
    index('idx_runs_root').on(table.root_run_id),
    index('idx_runs_parent').on(table.parent_run_id),
    index('idx_runs_claim').on(table.status, table.desired_state, table.not_before, table.priority),
    index('idx_runs_stale_lease').on(table.status, table.lease_expires_at),
    index('idx_runs_created').on(table.created_at),
    oneOf('chk_runs_kind', table.kind, RUN_KINDS),
    oneOf('chk_runs_status', table.status, RUN_STATUSES),
    oneOf('chk_runs_desired_state', table.desired_state, RUN_DESIRED_STATES),
    check('chk_runs_attempts', sql`${table.attempt} >= 0 AND ${table.max_attempts} > 0`),
    check('chk_runs_version', sql`${table.version} > 0`),
  ],
);

export const RUN_STEP_STATUSES = [...RUN_STATUSES, 'skipped'] as const;

export const runSteps = pgTable(
  'run_steps',
  {
    id: id(),
    run_id: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    parent_step_id: text('parent_step_id').references((): AnyPgColumn => runSteps.id, { onDelete: 'set null' }),
    step_key: text('step_key').notNull(),
    kind: text('kind').notNull(),
    attempt: integer('attempt').notNull().default(1),
    status: text('status', { enum: RUN_STEP_STATUSES }).notNull().default('queued'),
    lease_owner: text('lease_owner'),
    lease_expires_at: at('lease_expires_at'),
    heartbeat_at: at('heartbeat_at'),
    input: json<RuntimeJson>('input', {}),
    output: jsonOrNull<RuntimeJson>('output'),
    error_code: text('error_code'),
    error_message: text('error_message'),
    tokens_used: bigint('tokens_used', { mode: 'number' }).notNull().default(0),
    requests_used: bigint('requests_used', { mode: 'number' }).notNull().default(0),
    cost_micros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
    duration_ms: bigint('duration_ms', { mode: 'number' }),
    started_at: at('started_at'),
    ended_at: at('ended_at'),
    created_at: createdAt(),
    updated_at: updatedAt(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    uniqueIndex('uq_run_steps_run_key_attempt').on(table.run_id, table.step_key, table.attempt),
    index('idx_run_steps_run_created').on(table.run_id, table.created_at),
    index('idx_run_steps_parent').on(table.parent_step_id),
    index('idx_run_steps_claim').on(table.status, table.lease_expires_at),
    oneOf('chk_run_steps_status', table.status, RUN_STEP_STATUSES),
    check('chk_run_steps_attempt', sql`${table.attempt} > 0`),
    check(
      'chk_run_steps_usage',
      sql`${table.tokens_used} >= 0 AND ${table.requests_used} >= 0 AND ${table.cost_micros} >= 0 AND (${table.duration_ms} IS NULL OR ${table.duration_ms} >= 0)`,
    ),
    check('chk_run_steps_version', sql`${table.version} > 0`),
  ],
);

export const TOOL_CALL_STATUSES = [
  'pending',
  'awaiting_approval',
  'running',
  'succeeded',
  'failed',
  'canceled',
  'uncertain',
] as const;

export const runToolCalls = pgTable(
  'run_tool_calls',
  {
    id: id(),
    run_id: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    step_id: text('step_id').references(() => runSteps.id, { onDelete: 'set null' }),
    tool_name: text('tool_name').notNull(),
    status: text('status', { enum: TOOL_CALL_STATUSES }).notNull().default('pending'),
    input: json<RuntimeJson>('input', {}),
    output: jsonOrNull<RuntimeJson>('output'),
    canonical_input_hash: text('canonical_input_hash').notNull(),
    risk_level: text('risk_level', { enum: RISK_LEVELS }).notNull(),
    idempotency_key: text('idempotency_key'),
    /** Logical backlink: interrupts already strongly reference this row. */
    interrupt_id: text('interrupt_id'),
    /** Logical link to the permanent audit record. */
    platform_audit_event_id: text('platform_audit_event_id'),
    error_code: text('error_code'),
    error_message: text('error_message'),
    started_at: at('started_at'),
    ended_at: at('ended_at'),
    created_at: createdAt(),
    updated_at: updatedAt(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    index('idx_run_tool_calls_run_created').on(table.run_id, table.created_at),
    index('idx_run_tool_calls_step').on(table.step_id),
    index('idx_run_tool_calls_interrupt').on(table.interrupt_id),
    uniqueIndex('uq_run_tool_calls_run_idempotency')
      .on(table.run_id, table.idempotency_key)
      .where(sql`${table.idempotency_key} IS NOT NULL`),
    oneOf('chk_run_tool_calls_status', table.status, TOOL_CALL_STATUSES),
    oneOf('chk_run_tool_calls_risk', table.risk_level, RISK_LEVELS),
    check('chk_run_tool_calls_version', sql`${table.version} > 0`),
  ],
);

export const INTERRUPT_KINDS = [
  'mutation_approval',
  'workflow_gate',
  'ask_user',
  'credential_required',
  'budget_exceeded',
  'external_dependency',
  'outcome_unknown',
  'manual_pause',
] as const;
export const INTERRUPT_STATUSES = ['pending', 'resolved', 'rejected', 'expired', 'canceled'] as const;

export const runInterrupts = pgTable(
  'run_interrupts',
  {
    id: id(),
    run_id: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    step_id: text('step_id').references(() => runSteps.id, { onDelete: 'set null' }),
    tool_call_id: text('tool_call_id').references(() => runToolCalls.id, { onDelete: 'set null' }),
    kind: text('kind', { enum: INTERRUPT_KINDS }).notNull(),
    status: text('status', { enum: INTERRUPT_STATUSES }).notNull().default('pending'),
    payload: json<RuntimeJson>('payload', {}),
    canonical_input_hash: text('canonical_input_hash'),
    risk_level: text('risk_level', { enum: RISK_LEVELS }),
    assignee_user_id: text('assignee_user_id').notNull(),
    expires_at: at('expires_at'),
    decision: jsonOrNull<RuntimeJson>('decision'),
    decided_by_user_id: text('decided_by_user_id'),
    decided_at: at('decided_at'),
    created_at: createdAt(),
    updated_at: updatedAt(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    index('idx_run_interrupts_run_created').on(table.run_id, table.created_at),
    index('idx_run_interrupts_assignee_pending').on(table.assignee_user_id, table.status, table.created_at),
    index('idx_run_interrupts_step').on(table.step_id),
    index('idx_run_interrupts_tool').on(table.tool_call_id),
    oneOf('chk_run_interrupts_kind', table.kind, INTERRUPT_KINDS),
    oneOf('chk_run_interrupts_status', table.status, INTERRUPT_STATUSES),
    check('chk_run_interrupts_version', sql`${table.version} > 0`),
  ],
);

export const runEvents = pgTable(
  'run_events',
  {
    id: id(),
    run_id: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    /** Logical step reference keeps the exact historical identifier. */
    step_id: text('step_id'),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    type: text('type').notNull(),
    payload: json<RuntimeJson>('payload', {}),
    actor_user_id: text('actor_user_id'),
    idempotency_key: text('idempotency_key'),
    created_at: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_run_events_run_seq').on(table.run_id, table.seq),
    uniqueIndex('uq_run_events_run_idempotency')
      .on(table.run_id, table.idempotency_key)
      .where(sql`${table.idempotency_key} IS NOT NULL`),
    index('idx_run_events_run_created').on(table.run_id, table.created_at),
    index('idx_run_events_step').on(table.step_id),
    index('idx_run_events_created').on(table.created_at),
    check('chk_run_events_seq', sql`${table.seq} > 0`),
  ],
);

export const OUTBOX_STATUSES = ['pending', 'claimed', 'delivered', 'failed', 'dead_letter'] as const;

export const runOutbox = pgTable(
  'run_outbox',
  {
    id: id(),
    event_id: text('event_id')
      .notNull()
      .references(() => runEvents.id, { onDelete: 'cascade' }),
    topic: text('topic').notNull(),
    payload: json<RuntimeJson>('payload', {}),
    status: text('status', { enum: OUTBOX_STATUSES }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    max_attempts: integer('max_attempts').notNull().default(10),
    available_at: at('available_at').notNull(),
    lease_owner: text('lease_owner'),
    lease_expires_at: at('lease_expires_at'),
    last_error: text('last_error'),
    delivered_at: at('delivered_at'),
    created_at: createdAt(),
    updated_at: updatedAt(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    uniqueIndex('uq_run_outbox_event_topic').on(table.event_id, table.topic),
    index('idx_run_outbox_delivery').on(table.status, table.available_at, table.lease_expires_at),
    index('idx_run_outbox_delivered').on(table.delivered_at),
    oneOf('chk_run_outbox_status', table.status, OUTBOX_STATUSES),
    check('chk_run_outbox_attempts', sql`${table.attempts} >= 0 AND ${table.max_attempts} > 0`),
    check('chk_run_outbox_version', sql`${table.version} > 0`),
  ],
);

export type RuntimeRunRow = typeof runs.$inferSelect;
export type RuntimeRunKind = RuntimeRunRow['kind'];
export type RuntimeRunStatus = RuntimeRunRow['status'];
export type RuntimeDesiredState = RuntimeRunRow['desired_state'];
export type RuntimeStepRow = typeof runSteps.$inferSelect;
export type RuntimeStepStatus = RuntimeStepRow['status'];
export type RuntimeToolCallRow = typeof runToolCalls.$inferSelect;
export type RuntimeToolCallStatus = RuntimeToolCallRow['status'];
export type RuntimeActionRisk = RuntimeToolCallRow['risk_level'];
export type RuntimeInterruptRow = typeof runInterrupts.$inferSelect;
export type RuntimeInterruptStatus = RuntimeInterruptRow['status'];
export type RuntimeEventRow = typeof runEvents.$inferSelect;
export type RuntimeOutboxRow = typeof runOutbox.$inferSelect;
export type RuntimeOutboxStatus = RuntimeOutboxRow['status'];
