import { sql } from 'drizzle-orm';
import { bigint, index, integer, pgTable, text, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { at, createdAt, id, json, jsonOrNull, updatedAt } from './_columns.js';

export const RUN_KINDS = ['turn', 'background'] as const;
export type RunKind = (typeof RUN_KINDS)[number];
export const RUN_SOURCES = ['conversation', 'schedule', 'automation', 'record', 'handoff', 'app'] as const;
export type RunSource = (typeof RUN_SOURCES)[number];
export const RUN_STATUSES = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * A run: one thing an Agent does. Foreground replies are `turn` runs (hidden from the Runs
 * list); background work is `background`. Run history is permanent and keeps only logical
 * references to members, Agents and conversations.
 */
export const runs = pgTable(
  'runs',
  {
    id: id(),
    agentId: text('agent_id').notNull(),
    /** The member whose rights the run acts with. */
    ownerId: text('owner_id').notNull(),
    requestedBy: text('requested_by'),
    kind: text('kind', { enum: RUN_KINDS }).notNull(),
    source: text('source', { enum: RUN_SOURCES }).notNull(),
    sourceId: text('source_id'),
    conversationId: text('conversation_id'),
    parentRunId: text('parent_run_id').references((): AnyPgColumn => runs.id, { onDelete: 'cascade' }),
    rootRunId: text('root_run_id'),
    title: text('title').notNull().default(''),
    brief: text('brief').notNull().default(''),
    status: text('status', { enum: RUN_STATUSES }).notNull().default('queued'),
    /** What a member asked for (cancel); the worker converges on it. */
    desiredState: text('desired_state', { enum: ['run', 'cancel'] })
      .notNull()
      .default('run'),
    waitReason: text('wait_reason'),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: at('lease_expires_at'),
    heartbeatAt: at('heartbeat_at'),
    attempt: integer('attempt').notNull().default(0),
    deadlineAt: at('deadline_at'),
    /** Resume point for long work. */
    checkpoint: jsonOrNull<Record<string, unknown>>('checkpoint'),
    input: json<Record<string, unknown>>('input', {}),
    output: jsonOrNull<Record<string, unknown>>('output'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    version: integer('version').notNull().default(0),
    startedAt: at('started_at'),
    finishedAt: at('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('runs_owner_status_idx').on(t.ownerId, t.status),
    index('runs_agent_idx').on(t.agentId, t.createdAt),
    index('runs_claimable_idx')
      .on(t.status, t.leaseExpiresAt)
      .where(sql`${t.kind} = 'background'`),
    index('runs_conversation_idx').on(t.conversationId),
    // The single writer of a conversation: at most one turn is answering at a time.
    uniqueIndex('runs_one_active_turn_key')
      .on(t.conversationId)
      .where(sql`${t.kind} = 'turn' AND ${t.status} IN ('queued', 'running')`),
  ],
);

export const STEP_KINDS = ['model', 'tool', 'handoff', 'computer', 'wait'] as const;
export const STEP_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'skipped', 'uncertain'] as const;

/** A step is the unit of retry; a tool call is one kind of step. */
export const runSteps = pgTable(
  'run_steps',
  {
    id: id(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    parentStepId: text('parent_step_id'),
    key: text('key').notNull(),
    attempt: integer('attempt').notNull().default(1),
    kind: text('kind', { enum: STEP_KINDS }).notNull(),
    toolName: text('tool_name'),
    risk: text('risk', { enum: ['read', 'write', 'external'] }),
    idempotencyKey: text('idempotency_key'),
    requestId: text('request_id'),
    /** `uncertain`: the outside result is unknown, so the step is never replayed by itself. */
    status: text('status', { enum: STEP_STATUSES }).notNull().default('pending'),
    input: json<Record<string, unknown>>('input', {}),
    output: jsonOrNull<unknown>('output'),
    error: jsonOrNull<{ code: string; message: string }>('error'),
    tokens: jsonOrNull<{ input: number; output: number; cached?: number }>('tokens'),
    durationMs: integer('duration_ms'),
    startedAt: at('started_at'),
    finishedAt: at('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('run_steps_attempt_key').on(t.runId, t.key, t.attempt),
    uniqueIndex('run_steps_idempotency_key').on(t.runId, t.idempotencyKey),
  ],
);

/** The append-only timeline of a run; run details and live progress both read it. */
export const runEvents = pgTable(
  'run_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payload: json<Record<string, unknown>>('payload', {}),
    actor: text('actor'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('run_events_seq_key').on(t.runId, t.seq)],
);

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type RunStep = typeof runSteps.$inferSelect;
export type RunEvent = typeof runEvents.$inferSelect;
