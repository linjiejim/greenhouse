/**
 * Trusted Runtime Kernel service.
 *
 * Materialized Run/Step/Tool/Interrupt state is mutated with compare-and-set.
 * Every lifecycle mutation appends a permanent event and transactional outbox
 * row in the same PostgreSQL transaction. Claim paths use SKIP LOCKED leases;
 * no process-local queue or ownership state is authoritative.
 */

import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  canTransitionRuntimeArtifact,
  canTransitionRuntimeInterrupt,
  canTransitionRuntimeRun,
  canTransitionRuntimeStep,
  canTransitionRuntimeToolCall,
  isRuntimeInterruptCommandLegal,
  isRuntimeRunCommandLegal,
  type RuntimeInterruptCommand,
  type RuntimeInterruptStatus,
  type RuntimePayload,
  type RuntimeRunCommand,
} from '@greenhouse/types/runtime';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import {
  messages,
  runtimeArtifacts,
  runtimeEvents,
  runtimeInterrupts,
  runtimeOutbox,
  runtimeRuns,
  runtimeSteps,
  runtimeToolCalls,
  sessions,
} from '../schema/index.js';
import type { MessageRow, SessionRow } from '@greenhouse/types/session';
import type {
  RuntimeActionRisk,
  RuntimeArtifactRow,
  RuntimeArtifactStatus,
  RuntimeDesiredState,
  RuntimeEventRow,
  RuntimeInterruptRow,
  RuntimeOutboxRow,
  RuntimeRunKind,
  RuntimeRunRow,
  RuntimeRunStatus,
  RuntimeStepRow,
  RuntimeStepStatus,
  RuntimeToolCallRow,
  RuntimeToolCallStatus,
} from '../schema/runtime.js';

export type RuntimeKernelErrorCode =
  | 'runtime_invalid_input'
  | 'runtime_not_found'
  | 'runtime_version_conflict'
  | 'runtime_invalid_transition'
  | 'runtime_idempotency_conflict'
  | 'runtime_lease_lost';

export class RuntimeKernelError extends Error {
  constructor(
    public readonly code: RuntimeKernelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeKernelError';
  }
}

export interface RuntimeRunCreateInput {
  id?: string;
  kind: RuntimeRunKind;
  owner_user_id: string;
  initiated_by_user_id: string;
  session_id?: string | null;
  parent_run_id?: string | null;
  source_kind: string;
  source_id: string;
  idempotency_key?: string | null;
  priority?: number;
  not_before?: string | null;
  deadline_at?: string | null;
  max_attempts?: number;
  /**
   * Serialize creation by `(owner, kind, source_kind)` and reject a different
   * active source id while one exists. Automation uses this to make the
   * durable Runtime queue — rather than an in-process Set — the overlap fence
   * for one scheduled task definition.
   */
  single_active_source_kind?: boolean;
  /**
   * Subagent fan-out admission is a database fact, not a process-local counter.
   * Creation is serialized per parent session and rejected when the active
   * child count reaches the caller-supplied bound.
   */
  active_subagent_parent?: {
    parent_session_id: string;
    limit: number;
  };
  input: RuntimePayload;
  actor_user_id?: string | null;
  /**
   * First-writer policy used only by the one-time historical adapter backfill.
   * It is persisted atomically on `run.created` so a crash between creation and
   * the terminal transition cannot turn old history into a new unread alert.
   */
  suppress_initial_terminal_notification?: boolean;
}

export interface RuntimeRunTransitionInput {
  id: string;
  expected_version: number;
  to_status: RuntimeRunStatus;
  idempotency_key: string;
  actor_user_id?: string | null;
  desired_state?: RuntimeDesiredState;
  wait_reason?: string | null;
  output?: RuntimePayload | null;
  error_code?: string | null;
  error_message?: string | null;
  settled_at?: string | null;
  /**
   * Driver execution fence. Claimed→running renews a live lease before any
   * provider/tool I/O; terminal settlement proves the same live ownership and
   * atomically refuses a late success/failure after desired_state became cancel.
   */
  worker_id?: string;
  lease_ms?: number;
  /**
   * Read-model adapters and synchronous Chat traces do not own a worker
   * lease. They must opt in explicitly when projecting an already-running
   * source; durable driver kinds may never use this escape hatch.
   */
  projection_only?: boolean;
  /** Persist an immutable delivery policy for historical backfill events. */
  suppress_notification?: boolean;
}

export interface RuntimeRunClaimInput {
  worker_id: string;
  lease_ms: number;
  /** Inline drivers may claim their just-created exact Run without stealing another queue item. */
  run_id?: string;
  kinds?: readonly RuntimeRunKind[];
  at?: string | Date;
}

export interface RuntimeStepClaimInput {
  worker_id: string;
  lease_ms: number;
  /** Drivers claim only a case that belongs to the Run lease they own. */
  run_id: string;
  /** Optional exact step fence for a domain driver's case scheduler. */
  step_id?: string;
  at?: string | Date;
}

export interface RuntimeExecutionClaimInput {
  run_id: string;
  step_id: string;
  worker_id: string;
  lease_ms: number;
  at?: string | Date;
}

export interface RuntimeExecutionClaimResult {
  run: RuntimeRunRow;
  step: RuntimeStepRow;
}

/**
 * One atomic `spawn_session` admission. The deterministic child/message IDs
 * bind retries of the same tool call to the same transcript + Runtime source.
 */
export interface RuntimeSubagentAdmissionInput {
  agent_instance_id?: string;
  child_session_id: string;
  seed_message_id: string;
  owner_user_id: string;
  initiated_by_user_id: string;
  parent_session_id: string;
  parent_run_id?: string | null;
  profile_id: string;
  title: string;
  metadata: RuntimePayload;
  prompt: string;
  depth: number;
  max_steps: number;
  mode: 'sync' | 'async';
  timeout_ms: number;
  workspace_id: string | null;
  active_limit?: number;
  actor_user_id?: string | null;
}

export interface RuntimeSubagentAdmissionResult {
  session: SessionRow;
  message: MessageRow;
  run: RuntimeRunRow;
  step: RuntimeStepRow;
  idempotent: boolean;
}

export interface RuntimeChatTraceAdmissionInput {
  owner_user_id: string;
  initiated_by_user_id: string;
  session_id?: string | null;
  source_id: string;
  input: RuntimePayload;
  actor_user_id?: string | null;
}

export interface RuntimeChatTraceAdmissionResult {
  run: RuntimeRunRow;
  step: RuntimeStepRow;
}

export interface RuntimeRunListInput {
  owner_user_id?: string;
  kinds?: readonly RuntimeRunKind[];
  statuses?: readonly RuntimeRunStatus[];
  cursor?: { created_at: string; id: string };
  limit?: number;
}

export interface RuntimeRunListResult {
  items: RuntimeRunRow[];
  next_cursor: { created_at: string; id: string } | null;
}

export interface RuntimeRunDetail {
  run: RuntimeRunRow;
  events: RuntimeEventRow[];
  steps: RuntimeStepRow[];
  tool_calls: RuntimeToolCallRow[];
  artifacts: RuntimeArtifactRow[];
  interrupts: RuntimeInterruptRow[];
}

export interface RuntimeRunDomainCommandContext {
  /** Row locked by `SELECT .. FOR UPDATE` for the whole domain side effect. */
  run: RuntimeRunRow;
  /**
   * True only when the caller's expected Runtime version and command legality
   * still match the locked row. A driver may still return successfully when
   * the source domain already reached the requested state (crash-window
   * replay), but must never start a new side effect while this is false.
   */
  may_drive: boolean;
}

export interface RuntimeRunDomainCommandResult {
  run: RuntimeRunRow;
  idempotent: boolean;
}

export interface RuntimeStepCreateInput {
  id?: string;
  run_id: string;
  parent_step_id?: string | null;
  step_key: string;
  kind: string;
  attempt?: number;
  input: RuntimePayload;
  actor_user_id?: string | null;
  idempotency_key?: string;
}

export interface RuntimeStepTransitionInput {
  id: string;
  expected_version: number;
  to_status: RuntimeStepStatus;
  idempotency_key: string;
  actor_user_id?: string | null;
  output?: RuntimePayload | null;
  error_code?: string | null;
  error_message?: string | null;
  tokens_used?: number;
  requests_used?: number;
  cost_micros?: number;
  duration_ms?: number | null;
  /** Same live-lease fence as RuntimeRunTransitionInput for claimed Steps. */
  worker_id?: string;
  lease_ms?: number;
  /** Same projection-only exception as RuntimeRunTransitionInput. */
  projection_only?: boolean;
}

export interface RuntimeStepStaleRequeueInput {
  id: string;
  expected_version: number;
  idempotency_key: string;
  /**
   * Exact driver checkpoint that makes retry safe. The kernel never guesses
   * that an arbitrary running step is replayable.
   */
  checkpoint: RuntimePayload;
  at?: string | Date;
}

export interface RuntimeStepStaleRequeueResult {
  interrupted: RuntimeStepRow;
  replacement: RuntimeStepRow;
}

export interface RuntimeToolCallCreateInput {
  id?: string;
  run_id: string;
  step_id?: string | null;
  tool_name: string;
  input: RuntimePayload;
  canonical_input_hash: string;
  risk_level: RuntimeActionRisk;
  idempotency_key?: string | null;
  platform_audit_event_id?: string | null;
  actor_user_id?: string | null;
}

/**
 * Admission at the real tool execution boundary.
 *
 * Durable drivers prove the same live Run + Step lease that owns provider
 * execution. Chat is intentionally unleased, but may use the narrowly scoped
 * projection path for its already-running `chat_turn` trace. Both modes lock
 * the parent rows and persist pending -> running in one transaction.
 */
export interface RuntimeToolCallBeginInput extends RuntimeToolCallCreateInput {
  step_id: string;
  idempotency_key: string;
  actor_user_id: string;
  worker_id?: string;
  lease_ms?: number;
  projection_only?: boolean;
  at?: string | Date;
}

export interface RuntimeToolCallTransitionInput {
  id: string;
  expected_version: number;
  to_status: RuntimeToolCallStatus;
  event_idempotency_key: string;
  actor_user_id?: string | null;
  output?: RuntimePayload | null;
  error_code?: string | null;
  error_message?: string | null;
}

export interface RuntimeArtifactCreateInput {
  id?: string;
  run_id: string;
  step_id?: string | null;
  tool_call_id?: string | null;
  direction: RuntimeArtifactRow['direction'];
  kind: string;
  name: string;
  path?: string | null;
  content_type?: string | null;
  size_bytes?: number | null;
  sha256?: string | null;
  storage_key?: string | null;
  status?: RuntimeArtifactStatus;
  source: string;
  actor_user_id?: string | null;
  idempotency_key?: string;
}

export interface RuntimeInterruptCreateInput {
  id?: string;
  run_id: string;
  step_id?: string | null;
  tool_call_id?: string | null;
  kind: RuntimeInterruptRow['kind'];
  payload: RuntimePayload;
  canonical_input_hash?: string | null;
  risk_level?: RuntimeActionRisk | null;
  assignee_user_id: string;
  expires_at?: string | null;
  actor_user_id?: string | null;
  idempotency_key?: string;
}

export interface RuntimeEventAppendInput {
  run_id: string;
  step_id?: string | null;
  type: string;
  payload: RuntimePayload;
  actor_user_id?: string | null;
  idempotency_key?: string | null;
  topics?: readonly string[];
  available_at?: string;
  max_attempts?: number;
}

export interface RuntimeOutboxClaimInput {
  worker_id: string;
  lease_ms: number;
  topics?: readonly string[];
  limit?: number;
  at?: string | Date;
}

export interface RuntimeInterruptListInput {
  assignee_user_id?: string;
  status?: RuntimeInterruptStatus;
  kinds?: readonly RuntimeRunKind[];
  cursor?: { created_at: string; id: string };
  limit?: number;
}

export interface RuntimeInterruptListResult {
  items: Array<{ interrupt: RuntimeInterruptRow; run: RuntimeRunRow }>;
  next_cursor: { created_at: string; id: string } | null;
}

export interface RuntimeSummaryInput {
  owner_user_id?: string;
  assignee_user_id?: string;
  kinds?: readonly RuntimeRunKind[];
}

export interface RuntimeSummaryResult {
  runs: {
    total: number;
    by_status: Record<RuntimeRunStatus, number>;
    by_kind: Record<RuntimeRunKind, number>;
  };
  pending_interrupts: number;
}

const ACTIVE_RUN_STATUSES = ['queued', 'claimed', 'running', 'waiting', 'paused'] as const;
const LEASED_RUN_STATUSES = ['claimed', 'running'] as const;
const LEASED_STEP_STATUSES = ['claimed', 'running'] as const;
const SAFE_CLAIM_RECOVERY_CODE = 'runtime_claim_recovered';

function fail(code: RuntimeKernelErrorCode, message: string): never {
  throw new RuntimeKernelError(code, message);
}

function assertIdentifier(value: string, label: string, max = 512): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    fail('runtime_invalid_input', `${label} must contain 1-${max} characters`);
  }
  return normalized;
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('runtime_invalid_input', `${label} must be a positive safe integer`);
  }
  return value;
}

function assertNonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('runtime_invalid_input', `${label} must be a non-negative safe integer`);
  }
  return value;
}

function asIso(value: string | Date | undefined, label = 'timestamp'): string {
  if (value === undefined) return nowIso();
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) fail('runtime_invalid_input', `${label} must be a valid timestamp`);
  return parsed.toISOString();
}

function encodeJson(value: unknown, label: string): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail('runtime_invalid_input', `${label} must be JSON serializable`);
    return encoded;
  } catch (error) {
    if (error instanceof RuntimeKernelError) throw error;
    fail('runtime_invalid_input', `${label} must be JSON serializable`);
  }
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function prefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(encodeJson(value, 'idempotent command')).digest('hex');
}

function leaseExpiry(at: string, leaseMs: number): string {
  return new Date(Date.parse(at) + assertPositiveInteger(leaseMs, 'lease_ms')).toISOString();
}

function sameInstant(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return Date.parse(left) === Date.parse(right);
}

function normalizedTopics(topics: readonly string[] | undefined): string[] {
  const values = topics ?? ['runtime.events'];
  const normalized = [...new Set(values.map((topic) => assertIdentifier(topic, 'topic', 256)))].sort();
  if (normalized.length === 0) fail('runtime_invalid_input', 'At least one outbox topic is required');
  return normalized;
}

type TransactionalDb = Db;

async function requireStepInRun(
  tx: TransactionalDb,
  runId: string,
  stepId: string,
  label = 'step_id',
): Promise<RuntimeStepRow> {
  const [step] = await tx
    .select()
    .from(runtimeSteps)
    .where(and(eq(runtimeSteps.id, assertIdentifier(stepId, label)), eq(runtimeSteps.run_id, runId)))
    .limit(1);
  if (!step) fail('runtime_invalid_input', `${label} does not belong to runtime run ${runId}`);
  return step;
}

async function requireToolCallInRun(
  tx: TransactionalDb,
  runId: string,
  toolCallId: string,
): Promise<RuntimeToolCallRow> {
  const [toolCall] = await tx
    .select()
    .from(runtimeToolCalls)
    .where(
      and(eq(runtimeToolCalls.id, assertIdentifier(toolCallId, 'tool_call_id')), eq(runtimeToolCalls.run_id, runId)),
    )
    .limit(1);
  if (!toolCall) fail('runtime_invalid_input', `tool_call_id does not belong to runtime run ${runId}`);
  return toolCall;
}

async function appendEventInTransaction(
  tx: TransactionalDb,
  input: RuntimeEventAppendInput,
  at = nowIso(),
): Promise<RuntimeEventRow> {
  const runId = assertIdentifier(input.run_id, 'run_id');
  const eventType = assertIdentifier(input.type, 'event type', 256);
  const payload = encodeJson(input.payload, 'event payload');
  const idempotencyKey = input.idempotency_key
    ? assertIdentifier(input.idempotency_key, 'event idempotency_key')
    : null;
  const topics = normalizedTopics(input.topics);
  const availableAt = input.available_at ? asIso(input.available_at, 'available_at') : at;
  const maxAttempts = assertPositiveInteger(input.max_attempts ?? 10, 'max_attempts');

  const [run] = await tx
    .select({ id: runtimeRuns.id })
    .from(runtimeRuns)
    .where(eq(runtimeRuns.id, runId))
    .for('update');
  if (!run) fail('runtime_not_found', `Runtime run ${runId} was not found`);

  if (idempotencyKey) {
    const [existing] = await tx
      .select()
      .from(runtimeEvents)
      .where(and(eq(runtimeEvents.run_id, runId), eq(runtimeEvents.idempotency_key, idempotencyKey)))
      .limit(1);
    if (existing) {
      if (
        existing.type !== eventType ||
        existing.step_id !== (input.step_id ?? null) ||
        existing.payload !== payload ||
        existing.actor_user_id !== (input.actor_user_id ?? null)
      ) {
        fail('runtime_idempotency_conflict', 'Runtime event idempotency key was reused with different data');
      }
      const deliveries = await tx
        .select({
          topic: runtimeOutbox.topic,
          available_at: runtimeOutbox.available_at,
          max_attempts: runtimeOutbox.max_attempts,
        })
        .from(runtimeOutbox)
        .where(eq(runtimeOutbox.event_id, existing.id))
        .orderBy(asc(runtimeOutbox.topic));
      if (
        encodeJson(
          deliveries.map((row) => row.topic),
          'topics',
        ) !== encodeJson(topics, 'topics')
      ) {
        fail('runtime_idempotency_conflict', 'Runtime event idempotency key was reused with different topics');
      }
      if (deliveries.some((row) => row.max_attempts !== maxAttempts)) {
        fail('runtime_idempotency_conflict', 'Runtime event idempotency key was reused with different max_attempts');
      }
      if (input.available_at !== undefined && deliveries.some((row) => !sameInstant(row.available_at, availableAt))) {
        fail('runtime_idempotency_conflict', 'Runtime event idempotency key was reused with different available_at');
      }
      return existing;
    }
  }

  if (input.step_id) await requireStepInRun(tx, runId, input.step_id);

  const [event] = await tx
    .insert(runtimeEvents)
    .values({
      id: prefixedId('rte'),
      run_id: runId,
      step_id: input.step_id ?? null,
      // Keep allocation and insertion in one PostgreSQL statement. The Run row
      // lock above serializes independent transactions; the single statement
      // also closes the select→insert interleaving possible when test/service
      // calls share one outer transaction and its row lock is re-entrant.
      seq: sql<number>`(SELECT COALESCE(MAX(${runtimeEvents.seq}), 0) + 1 FROM ${runtimeEvents} WHERE ${runtimeEvents.run_id} = ${runId})`,
      type: eventType,
      payload,
      actor_user_id: input.actor_user_id ?? null,
      idempotency_key: idempotencyKey,
      created_at: at,
    })
    .returning();

  const deliveryPayload = encodeJson(
    {
      event_id: event!.id,
      run_id: event!.run_id,
      step_id: event!.step_id,
      seq: event!.seq,
      type: event!.type,
      payload: input.payload,
      actor_user_id: event!.actor_user_id,
      created_at: event!.created_at,
    },
    'outbox payload',
  );
  await tx.insert(runtimeOutbox).values(
    topics.map((topic) => ({
      id: prefixedId('rto'),
      event_id: event!.id,
      topic,
      payload: deliveryPayload,
      status: 'pending' as const,
      attempts: 0,
      max_attempts: maxAttempts,
      available_at: availableAt,
      created_at: at,
      updated_at: at,
    })),
  );
  return event!;
}

interface StoredCommandResult<T> {
  command_fingerprint: string;
  result: T;
}

function replayCommand<T>(event: RuntimeEventRow, expectedFingerprint: string): T {
  const payload = parseJson<StoredCommandResult<T>>(event.payload);
  if (payload.command_fingerprint !== expectedFingerprint) {
    fail('runtime_idempotency_conflict', 'Runtime command idempotency key was reused with different input');
  }
  return payload.result;
}

function desiredStateForCommand(command: RuntimeRunCommand['type']): RuntimeDesiredState {
  if (command === 'pause') return 'pause';
  if (command === 'cancel') return 'cancel';
  return 'run';
}

export function createRuntimeService(db: Db) {
  const service = {
    // ─── Runs ────────────────────────────────────────────

    async admitSubagent(input: RuntimeSubagentAdmissionInput): Promise<RuntimeSubagentAdmissionResult> {
      const childSessionId = assertIdentifier(input.child_session_id, 'child_session_id');
      const seedMessageId = assertIdentifier(input.seed_message_id, 'seed_message_id');
      const ownerUserId = assertIdentifier(input.owner_user_id, 'owner_user_id');
      const initiatedBy = assertIdentifier(input.initiated_by_user_id, 'initiated_by_user_id');
      const parentSessionId = assertIdentifier(input.parent_session_id, 'parent_session_id');
      const parentRunId = input.parent_run_id ? assertIdentifier(input.parent_run_id, 'parent_run_id') : null;
      const profileId = assertIdentifier(input.profile_id, 'profile_id');
      const title = assertIdentifier(input.title, 'title');
      const prompt = assertIdentifier(input.prompt, 'prompt', 100_000);
      const depth = assertPositiveInteger(input.depth, 'depth');
      const maxSteps = assertPositiveInteger(input.max_steps, 'max_steps');
      if (maxSteps > 30) fail('runtime_invalid_input', 'max_steps must not exceed 30');
      const timeoutMs = assertPositiveInteger(input.timeout_ms, 'timeout_ms');
      const activeLimit =
        input.active_limit === undefined ? undefined : assertPositiveInteger(input.active_limit, 'active_limit');
      const workspaceId = input.workspace_id ? assertIdentifier(input.workspace_id, 'workspace_id') : null;
      const metadata = encodeJson(input.metadata, 'subagent session metadata');
      const runInput = {
        child_session_id: childSessionId,
        parent_session_id: parentSessionId,
        profile_id: profileId,
        prompt,
        title,
        depth,
        max_steps: maxSteps,
        mode: input.mode,
        timeout_ms: timeoutMs,
        workspace_id: workspaceId,
      } satisfies RuntimePayload;
      const stepInput = {
        child_session_id: childSessionId,
        prompt,
        profile_id: profileId,
        max_steps: maxSteps,
      } satisfies RuntimePayload;

      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as TransactionalDb;
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`runtime-subagent-admit:${childSessionId}`}, 0))`,
        );

        const [parent] = await tx
          .select()
          .from(sessions)
          .where(eq(sessions.id, parentSessionId))
          .for('update')
          .limit(1);
        if (!parent || parent.user_id !== ownerUserId) {
          fail('runtime_not_found', 'Subagent parent session is missing or belongs to another owner');
        }

        if (parentRunId) {
          const [parentRun] = await tx
            .select()
            .from(runtimeRuns)
            .where(eq(runtimeRuns.id, parentRunId))
            .for('update')
            .limit(1);
          if (!parentRun || parentRun.owner_user_id !== ownerUserId || parentRun.session_id !== parentSessionId) {
            fail('runtime_not_found', 'Subagent parent Runtime is missing or does not own the parent session');
          }
          if ((parentRun.status !== 'claimed' && parentRun.status !== 'running') || parentRun.desired_state !== 'run') {
            fail('runtime_invalid_transition', 'Subagent parent Runtime is no longer accepting child work');
          }
        }

        const [existingSession] = await tx
          .select()
          .from(sessions)
          .where(eq(sessions.id, childSessionId))
          .for('update')
          .limit(1);
        let session: SessionRow;
        let message: MessageRow;
        let idempotent = false;
        if (existingSession) {
          if (
            existingSession.agent_instance_id !== (input.agent_instance_id ?? null) ||
            existingSession.title !== title ||
            existingSession.status !== 'active' ||
            existingSession.profile_id !== profileId ||
            existingSession.user_id !== ownerUserId ||
            existingSession.channel !== 'subagent' ||
            existingSession.parent_session_id !== parentSessionId ||
            existingSession.metadata !== metadata
          ) {
            fail('runtime_idempotency_conflict', 'Subagent admission identity was reused with different session input');
          }
          const [existingMessage] = await tx.select().from(messages).where(eq(messages.id, seedMessageId)).limit(1);
          if (
            !existingMessage ||
            existingMessage.session_id !== childSessionId ||
            existingMessage.role !== 'user' ||
            existingMessage.content !== prompt ||
            existingMessage.seq !== 0
          ) {
            fail('runtime_idempotency_conflict', 'Subagent admission seed message is missing or changed');
          }
          session = existingSession as SessionRow;
          message = existingMessage as MessageRow;
          idempotent = true;
        } else {
          const [messageCollision] = await tx.select().from(messages).where(eq(messages.id, seedMessageId)).limit(1);
          if (messageCollision) {
            fail('runtime_idempotency_conflict', 'Subagent seed message identity already belongs to another session');
          }
          const at = nowIso();
          const [createdSession] = await tx
            .insert(sessions)
            .values({
              id: childSessionId,
              title,
              status: 'active',
              profile_id: profileId,
              user_id: ownerUserId,
              app_id: null,
              channel: 'subagent',
              agent_instance_id: input.agent_instance_id ?? null,
              parent_session_id: parentSessionId,
              metadata,
              created_at: at,
              updated_at: at,
            })
            .returning();
          const [createdMessage] = await tx
            .insert(messages)
            .values({
              id: seedMessageId,
              session_id: childSessionId,
              role: 'user',
              content: prompt,
              references_: '[]',
              pipeline: '[]',
              reasoning: null,
              model: null,
              images: '[]',
              confidence: null,
              grounded: null,
              input_tokens: null,
              output_tokens: null,
              cached_tokens: null,
              reasoning_tokens: null,
              duration_ms: null,
              seq: 0,
              created_at: at,
            })
            .returning();
          session = createdSession as SessionRow;
          message = createdMessage as MessageRow;
        }

        // Bind services to this outer transaction. Their nested transactions
        // are savepoints, so transcript + Run + Step either all commit or all
        // disappear when any identity/admission check fails.
        const nested = createRuntimeService(tx);
        const run = await nested.createRun({
          kind: 'subagent',
          owner_user_id: ownerUserId,
          initiated_by_user_id: initiatedBy,
          session_id: childSessionId,
          ...(parentRunId ? { parent_run_id: parentRunId } : {}),
          source_kind: 'spawned_session',
          source_id: childSessionId,
          idempotency_key: `spawned-session:${childSessionId}`,
          max_attempts: 1,
          input: runInput,
          actor_user_id: input.actor_user_id ?? initiatedBy,
          ...(input.mode === 'async' && activeLimit
            ? {
                active_subagent_parent: {
                  parent_session_id: parentSessionId,
                  limit: activeLimit,
                },
              }
            : {}),
        });
        const step = await nested.createStep({
          run_id: run.id,
          step_key: 'agent-turn',
          kind: 'subagent_turn',
          input: stepInput,
          actor_user_id: input.actor_user_id ?? initiatedBy,
          idempotency_key: 'subagent:step:created',
        });
        return { session, message, run, step, idempotent };
      });
    },

    /**
     * Atomically verify/lock a conversation and create its Chat Run + Step.
     * Session deletion takes the same row lock before checking active Runtime
     * rows, closing the delete-vs-provider-admission race.
     */
    async admitChatTrace(input: RuntimeChatTraceAdmissionInput): Promise<RuntimeChatTraceAdmissionResult> {
      const ownerUserId = assertIdentifier(input.owner_user_id, 'owner_user_id');
      const initiatedBy = assertIdentifier(input.initiated_by_user_id, 'initiated_by_user_id');
      const sessionId = input.session_id ? assertIdentifier(input.session_id, 'session_id') : null;
      const sourceId = assertIdentifier(input.source_id, 'source_id');
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as TransactionalDb;
        if (sessionId) {
          const [session] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).for('update').limit(1);
          if (!session || session.user_id !== ownerUserId) {
            fail('runtime_not_found', 'Chat session is missing or belongs to another owner');
          }
        }
        const nested = createRuntimeService(tx);
        const run = await nested.createRun({
          kind: 'chat',
          owner_user_id: ownerUserId,
          initiated_by_user_id: initiatedBy,
          session_id: sessionId,
          source_kind: 'chat_turn',
          source_id: sourceId,
          idempotency_key: sourceId,
          max_attempts: 1,
          input: input.input,
          actor_user_id: input.actor_user_id ?? initiatedBy,
        });
        const step = await nested.createStep({
          run_id: run.id,
          step_key: 'chat_turn',
          kind: 'chat_turn',
          input: input.input,
          actor_user_id: input.actor_user_id ?? initiatedBy,
          idempotency_key: 'chat:step:created',
        });
        return { run, step };
      });
    },

    async createRun(input: RuntimeRunCreateInput): Promise<RuntimeRunRow> {
      const id = input.id ? assertIdentifier(input.id, 'id') : prefixedId('rtr');
      const ownerUserId = assertIdentifier(input.owner_user_id, 'owner_user_id');
      const initiatedBy = assertIdentifier(input.initiated_by_user_id, 'initiated_by_user_id');
      const sourceKind = assertIdentifier(input.source_kind, 'source_kind');
      const sourceId = assertIdentifier(input.source_id, 'source_id');
      const idempotencyKey = input.idempotency_key ? assertIdentifier(input.idempotency_key, 'idempotency_key') : null;
      const priority = assertNonnegativeInteger(input.priority ?? 0, 'priority');
      const maxAttempts = assertPositiveInteger(input.max_attempts ?? 3, 'max_attempts');
      const encodedInput = encodeJson(input.input, 'run input');
      const activeSubagentParent = input.active_subagent_parent
        ? {
            parent_session_id: assertIdentifier(
              input.active_subagent_parent.parent_session_id,
              'active_subagent_parent.parent_session_id',
            ),
            limit: assertPositiveInteger(input.active_subagent_parent.limit, 'active_subagent_parent.limit'),
          }
        : null;
      if (activeSubagentParent && (input.kind !== 'subagent' || sourceKind !== 'spawned_session')) {
        fail('runtime_invalid_input', 'active_subagent_parent is only valid for spawned_session subagent Runs');
      }
      const notBefore = input.not_before ? asIso(input.not_before, 'not_before') : null;
      const deadlineAt = input.deadline_at ? asIso(input.deadline_at, 'deadline_at') : null;
      if (notBefore && deadlineAt && Date.parse(deadlineAt) <= Date.parse(notBefore)) {
        fail('runtime_invalid_input', 'deadline_at must be later than not_before');
      }

      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as TransactionalDb;
        const creationLock = activeSubagentParent
          ? `runtime-create-subagent:${ownerUserId}:${activeSubagentParent.parent_session_id}`
          : input.single_active_source_kind
            ? `runtime-create-active:${ownerUserId}:${input.kind}:${sourceKind}`
            : `runtime-create:${ownerUserId}:${input.kind}:${idempotencyKey ?? `${sourceKind}:${sourceId}`}`;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${creationLock}, 0))`);

        const candidates = await tx
          .select()
          .from(runtimeRuns)
          .where(
            or(
              and(
                eq(runtimeRuns.kind, input.kind),
                eq(runtimeRuns.source_kind, sourceKind),
                eq(runtimeRuns.source_id, sourceId),
              ),
              ...(idempotencyKey
                ? [
                    and(
                      eq(runtimeRuns.owner_user_id, ownerUserId),
                      eq(runtimeRuns.kind, input.kind),
                      eq(runtimeRuns.idempotency_key, idempotencyKey),
                    ),
                  ]
                : []),
            ),
          )
          .limit(2);

        let rootRunId = id;
        if (input.parent_run_id) {
          const parentId = assertIdentifier(input.parent_run_id, 'parent_run_id');
          const [parent] = await tx.select().from(runtimeRuns).where(eq(runtimeRuns.id, parentId)).limit(1);
          if (!parent) fail('runtime_not_found', `Parent runtime run ${parentId} was not found`);
          rootRunId = parent.root_run_id;
        }

        if (candidates.length > 0) {
          const existing = candidates[0]!;
          const same =
            (input.id === undefined || existing.id === id) &&
            existing.kind === input.kind &&
            existing.owner_user_id === ownerUserId &&
            existing.initiated_by_user_id === initiatedBy &&
            existing.session_id === (input.session_id ?? null) &&
            existing.parent_run_id === (input.parent_run_id ?? null) &&
            existing.root_run_id === (input.parent_run_id ? rootRunId : existing.id) &&
            existing.source_kind === sourceKind &&
            existing.source_id === sourceId &&
            existing.idempotency_key === idempotencyKey &&
            existing.priority === priority &&
            sameInstant(existing.not_before, notBefore) &&
            sameInstant(existing.deadline_at, deadlineAt) &&
            existing.max_attempts === maxAttempts &&
            existing.input === encodedInput;
          if (!same || candidates.some((row) => row.id !== existing.id)) {
            fail('runtime_idempotency_conflict', 'Runtime run identity was reused with different input');
          }
          return existing;
        }

        if (input.single_active_source_kind) {
          const [active] = await tx
            .select({ id: runtimeRuns.id })
            .from(runtimeRuns)
            .where(
              and(
                eq(runtimeRuns.owner_user_id, ownerUserId),
                eq(runtimeRuns.kind, input.kind),
                eq(runtimeRuns.source_kind, sourceKind),
                inArray(runtimeRuns.status, [...ACTIVE_RUN_STATUSES]),
              ),
            )
            .limit(1);
          if (active) {
            fail('runtime_invalid_transition', `Runtime source ${sourceKind} already has an active run`);
          }
        }

        if (activeSubagentParent) {
          const [active] = await tx
            .select({ count: sql<number>`COUNT(*)` })
            .from(runtimeRuns)
            .where(
              and(
                eq(runtimeRuns.owner_user_id, ownerUserId),
                eq(runtimeRuns.kind, 'subagent'),
                eq(runtimeRuns.source_kind, 'spawned_session'),
                inArray(runtimeRuns.status, [...ACTIVE_RUN_STATUSES]),
                sql`${runtimeRuns.input}::jsonb ->> 'parent_session_id' = ${activeSubagentParent.parent_session_id}`,
                sql`${runtimeRuns.input}::jsonb ->> 'mode' = 'async'`,
              ),
            );
          if (Number(active?.count ?? 0) >= activeSubagentParent.limit) {
            fail(
              'runtime_invalid_transition',
              `Too many active subagent Runs for parent session (max ${activeSubagentParent.limit})`,
            );
          }
        }

        const at = nowIso();
        const [created] = await tx
          .insert(runtimeRuns)
          .values({
            id,
            kind: input.kind,
            owner_user_id: ownerUserId,
            initiated_by_user_id: initiatedBy,
            session_id: input.session_id ?? null,
            parent_run_id: input.parent_run_id ?? null,
            root_run_id: rootRunId,
            source_kind: sourceKind,
            source_id: sourceId,
            idempotency_key: idempotencyKey,
            priority,
            not_before: notBefore,
            deadline_at: deadlineAt,
            max_attempts: maxAttempts,
            input: encodedInput,
            created_at: at,
            updated_at: at,
          })
          .returning();
        await appendEventInTransaction(
          tx,
          {
            run_id: id,
            type: 'run.created',
            payload: {
              run: created!,
              ...(input.suppress_initial_terminal_notification
                ? { notification_policy: 'suppress_initial_terminal' }
                : {}),
            } as unknown as RuntimePayload,
            actor_user_id: input.actor_user_id ?? initiatedBy,
            idempotency_key: 'run.created',
          },
          at,
        );
        return created!;
      });
    },

    async getRun(id: string): Promise<RuntimeRunRow | undefined> {
      const [row] = await db.select().from(runtimeRuns).where(eq(runtimeRuns.id, id)).limit(1);
      return row;
    },

    async getRunBySource(
      kind: RuntimeRunKind,
      sourceKind: string,
      sourceId: string,
    ): Promise<RuntimeRunRow | undefined> {
      const [row] = await db
        .select()
        .from(runtimeRuns)
        .where(
          and(
            eq(runtimeRuns.kind, kind),
            eq(runtimeRuns.source_kind, assertIdentifier(sourceKind, 'source_kind')),
            eq(runtimeRuns.source_id, assertIdentifier(sourceId, 'source_id')),
          ),
        )
        .limit(1);
      return row;
    },

    /** Most recent active execution envelope bound to this exact session. */
    async findActiveRunBySession(sessionId: string, ownerUserId?: string): Promise<RuntimeRunRow | undefined> {
      const [row] = await db
        .select()
        .from(runtimeRuns)
        .where(
          and(
            eq(runtimeRuns.session_id, assertIdentifier(sessionId, 'session_id')),
            inArray(runtimeRuns.status, [...ACTIVE_RUN_STATUSES]),
            ...(ownerUserId ? [eq(runtimeRuns.owner_user_id, assertIdentifier(ownerUserId, 'owner_user_id'))] : []),
          ),
        )
        .orderBy(desc(runtimeRuns.created_at), desc(runtimeRuns.id))
        .limit(1);
      return row;
    },

    /** Durable replacement for the old process-local async child counter. */
    async countActiveSubagentRuns(parentSessionId: string, ownerUserId?: string): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(runtimeRuns)
        .where(
          and(
            eq(runtimeRuns.kind, 'subagent'),
            eq(runtimeRuns.source_kind, 'spawned_session'),
            inArray(runtimeRuns.status, [...ACTIVE_RUN_STATUSES]),
            sql`${runtimeRuns.input}::jsonb ->> 'parent_session_id' = ${assertIdentifier(parentSessionId, 'parent_session_id')}`,
            ...(ownerUserId ? [eq(runtimeRuns.owner_user_id, assertIdentifier(ownerUserId, 'owner_user_id'))] : []),
          ),
        );
      return Number(row?.count ?? 0);
    },

    async listRunsByOwner(ownerUserId: string, limit = 50): Promise<RuntimeRunRow[]> {
      return db
        .select()
        .from(runtimeRuns)
        .where(eq(runtimeRuns.owner_user_id, ownerUserId))
        .orderBy(desc(runtimeRuns.created_at), desc(runtimeRuns.id))
        .limit(Math.min(Math.max(limit, 1), 200));
    },

    /**
     * All runs of one source definition (e.g. every occurrence of a scheduled
     * task, `source_kind='scheduled_task:<id>'`). Hits the prefix of
     * `uq_runtime_runs_source`, so it stays an index scan as `runtime_runs`
     * grows with chat traces.
     */
    async listRunsForSource(kind: RuntimeRunKind, sourceKind: string, limit = 100): Promise<RuntimeRunRow[]> {
      return db
        .select()
        .from(runtimeRuns)
        .where(and(eq(runtimeRuns.kind, kind), eq(runtimeRuns.source_kind, sourceKind)))
        .orderBy(desc(runtimeRuns.created_at), desc(runtimeRuns.id))
        .limit(Math.min(Math.max(limit, 1), 200));
    },

    async listRuns(input: RuntimeRunListInput = {}): Promise<RuntimeRunListResult> {
      const ownerUserId = input.owner_user_id ? assertIdentifier(input.owner_user_id, 'owner_user_id') : null;
      const kinds = input.kinds ? [...new Set(input.kinds)] : null;
      const statuses = input.statuses ? [...new Set(input.statuses)] : null;
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
      const cursor = input.cursor
        ? {
            created_at: asIso(input.cursor.created_at, 'cursor.created_at'),
            id: assertIdentifier(input.cursor.id, 'cursor.id'),
          }
        : null;
      if (kinds?.length === 0 || statuses?.length === 0) return { items: [], next_cursor: null };
      const rows = await db
        .select()
        .from(runtimeRuns)
        .where(
          and(
            ...(ownerUserId ? [eq(runtimeRuns.owner_user_id, ownerUserId)] : []),
            ...(kinds ? [inArray(runtimeRuns.kind, kinds)] : []),
            ...(statuses ? [inArray(runtimeRuns.status, statuses)] : []),
            ...(cursor
              ? [
                  or(
                    sql`${runtimeRuns.created_at} < ${cursor.created_at}`,
                    and(eq(runtimeRuns.created_at, cursor.created_at), sql`${runtimeRuns.id} < ${cursor.id}`),
                  ),
                ]
              : []),
          ),
        )
        .orderBy(desc(runtimeRuns.created_at), desc(runtimeRuns.id))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const tail = items.at(-1);
      return {
        items,
        next_cursor:
          hasMore && tail
            ? {
                created_at: tail.created_at,
                id: tail.id,
              }
            : null,
      };
    },

    async getRunDetail(id: string): Promise<RuntimeRunDetail | undefined> {
      const runId = assertIdentifier(id, 'id');
      const run = await service.getRun(runId);
      if (!run) return undefined;
      const [events, steps, toolCalls, artifacts, interrupts] = await Promise.all([
        // Detail/Trace capture is the explicit full-fidelity surface. The
        // incremental HTTP timeline uses listEvents() pagination, but silently
        // dropping event 1001 here would make Task Center and Trace→Dataset
        // disagree with the permanent Runtime fact store.
        service.listAllEvents(runId),
        service.listSteps(runId),
        service.listToolCalls(runId),
        service.listArtifacts(runId),
        service.listInterrupts(runId),
      ]);
      return {
        run,
        events,
        steps,
        tool_calls: toolCalls,
        artifacts,
        interrupts,
      };
    },

    async transitionRun(input: RuntimeRunTransitionInput): Promise<RuntimeRunRow> {
      const id = assertIdentifier(input.id, 'id');
      const expectedVersion = assertPositiveInteger(input.expected_version, 'expected_version');
      const idempotencyKey = assertIdentifier(input.idempotency_key, 'idempotency_key');
      const workerId = input.worker_id ? assertIdentifier(input.worker_id, 'worker_id') : null;
      if ((workerId === null) !== (input.lease_ms === undefined)) {
        fail('runtime_invalid_input', 'worker_id and lease_ms must be supplied together');
      }
      const workerTransitionAllowed =
        input.to_status === 'running' || ['succeeded', 'failed', 'canceled', 'interrupted'].includes(input.to_status);
      if (workerId && !workerTransitionAllowed) {
        fail('runtime_invalid_input', 'A live lease fence is only valid when entering running or terminal state');
      }
      if (input.projection_only && (workerId || input.to_status !== 'running')) {
        fail('runtime_invalid_input', 'projection_only is only valid for an unleased transition into running');
      }
      const commandFingerprint = fingerprint({ ...input, actor_user_id: input.actor_user_id ?? null });

      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as TransactionalDb;
        const [locked] = await tx.select().from(runtimeRuns).where(eq(runtimeRuns.id, id)).for('update');
        if (!locked) fail('runtime_not_found', `Runtime run ${id} was not found`);
        const [replayed] = await tx
          .select()
          .from(runtimeEvents)
          .where(and(eq(runtimeEvents.run_id, id), eq(runtimeEvents.idempotency_key, idempotencyKey)))
          .limit(1);
        if (replayed) return replayCommand<RuntimeRunRow>(replayed, commandFingerprint);
        if (locked.version !== expectedVersion) {
          fail('runtime_version_conflict', `Runtime run ${id} is at version ${locked.version}`);
        }
        if (!canTransitionRuntimeRun(locked.status, input.to_status)) {
          fail(
            'runtime_invalid_transition',
            `Cannot transition runtime run from ${locked.status} to ${input.to_status}`,
          );
        }

        if (
          input.to_status === 'running' &&
          !workerId &&
          !input.projection_only &&
          (locked.kind === 'eval' || locked.kind === 'automation' || locked.kind === 'subagent')
        ) {
          fail('runtime_lease_lost', `Runtime ${locked.kind} run ${id} requires a live driver claim`);
        }

        const at = nowIso();
        const terminal = ['succeeded', 'failed', 'canceled', 'interrupted'].includes(input.to_status);
        if (workerId) {
          const validSourceStatus =
            input.to_status === 'running'
              ? locked.status === 'claimed'
              : terminal && (locked.status === 'claimed' || locked.status === 'running');
          const desiredMatches =
            input.to_status === 'canceled'
              ? locked.desired_state === 'cancel' || input.desired_state === 'cancel'
              : !terminal || locked.desired_state === 'run';
          if (
            !validSourceStatus ||
            !desiredMatches ||
            locked.lease_owner !== workerId ||
            !locked.lease_expires_at ||
            Date.parse(locked.lease_expires_at) <= Date.parse(at)
          ) {
            fail('runtime_lease_lost', `Runtime run ${id} no longer has terminal authority for ${workerId}`);
          }
        }
        const renewedLease = workerId && input.to_status === 'running' ? leaseExpiry(at, input.lease_ms!) : null;
        const releasesLease = terminal || ['queued', 'waiting', 'paused'].includes(input.to_status);
        const [updated] = await tx
          .update(runtimeRuns)
          .set({
            status: input.to_status,
            ...(input.desired_state !== undefined ? { desired_state: input.desired_state } : {}),
            ...(input.wait_reason !== undefined ? { wait_reason: input.wait_reason } : {}),
            ...(input.output !== undefined
              ? { output: input.output === null ? null : encodeJson(input.output, 'run output') }
              : {}),
            ...(input.error_code !== undefined ? { error_code: input.error_code } : {}),
            ...(input.error_message !== undefined ? { error_message: input.error_message } : {}),
            ...(input.settled_at !== undefined
              ? { settled_at: input.settled_at === null ? null : asIso(input.settled_at, 'settled_at') }
              : {}),
            ...(input.to_status === 'running' && !locked.started_at ? { started_at: at } : {}),
            ...(renewedLease ? { lease_expires_at: renewedLease, heartbeat_at: at } : {}),
            ...(releasesLease ? { lease_owner: null, lease_expires_at: null } : {}),
            ...(terminal ? { ended_at: at } : {}),
            updated_at: at,
            version: sql`${runtimeRuns.version} + 1`,
          })
          .where(and(eq(runtimeRuns.id, id), eq(runtimeRuns.version, expectedVersion)))
          .returning();
        if (!updated) fail('runtime_version_conflict', `Runtime run ${id} changed concurrently`);
        await appendEventInTransaction(
          tx,
          {
            run_id: id,
            type: 'run.status_changed',
            payload: {
              command_fingerprint: commandFingerprint,
              result: updated!,
              ...(input.suppress_notification ? { notification_policy: 'suppress' } : {}),
            } as unknown as RuntimePayload,
            actor_user_id: input.actor_user_id ?? null,
            idempotency_key: idempotencyKey,
          },
          at,
        );
        return updated!;
      });
    },

    async commandRun(command: RuntimeRunCommand, actorUserId?: string | null): Promise<RuntimeRunRow> {
      const id = assertIdentifier(command.run_id, 'run_id');
      const expectedVersion = assertPositiveInteger(command.expected_version, 'expected_version');
      const idempotencyKey = assertIdentifier(command.idempotency_key, 'idempotency_key');
      const commandFingerprint = fingerprint(command);
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as TransactionalDb;
        const [locked] = await tx.select().from(runtimeRuns).where(eq(runtimeRuns.id, id)).for('update');
        if (!locked) fail('runtime_not_found', `Runtime run ${id} was not found`);
        const [replayed] = await tx
          .select()
          .from(runtimeEvents)
          .where(and(eq(runtimeEvents.run_id, id), eq(runtimeEvents.idempotency_key, idempotencyKey)))
          .limit(1);
        if (replayed) return replayCommand<RuntimeRunRow>(replayed, commandFingerprint);
        if (locked.version !== expectedVersion) {
          fail('runtime_version_conflict', `Runtime run ${id} is at version ${locked.version}`);
        }
        if (!isRuntimeRunCommandLegal(locked.status, command.type, locked.desired_state)) {
          fail('runtime_invalid_transition', `Command ${command.type} is not legal for ${locked.status}`);
        }

        const at = nowIso();
        const next: Partial<typeof runtimeRuns.$inferInsert> = { updated_at: at };
        if (command.type === 'start') next.desired_state = 'run';
        if (command.type === 'pause') {
          next.status = 'paused';
          next.desired_state = 'pause';
          next.lease_owner = null;
          next.lease_expires_at = null;
        }
        if (command.type === 'resume') {
          next.status = 'queued';
          next.desired_state = 'run';
          next.lease_owner = null;
          next.lease_expires_at = null;
        }
        if (command.type === 'cancel') {
          next.status = 'canceled';
          next.desired_state = 'cancel';
          next.lease_owner = null;
          next.lease_expires_at = null;
          next.ended_at = at;
        }
        if (command.type === 'retry') {
          next.status = 'queued';
          next.desired_state = 'run';
          next.error_code = null;
          next.error_message = null;
          next.ended_at = null;
          next.settled_at = null;
          next.lease_owner = null;
          next.lease_expires_at = null;
        }
        const [updated] = await tx
          .update(runtimeRuns)
          .set({ ...next, version: sql`${runtimeRuns.version} + 1` })
          .where(and(eq(runtimeRuns.id, id), eq(runtimeRuns.version, expectedVersion)))
          .returning();
        if (!updated) fail('runtime_version_conflict', `Runtime run ${id} changed concurrently`);
        await appendEventInTransaction(
          tx,
          {
            run_id: id,
            type: 'run.commanded',
            payload: { command_fingerprint: commandFingerprint, result: updated! } as unknown as RuntimePayload,
            actor_user_id: actorUserId ?? null,
            idempotency_key: idempotencyKey,
          },
          at,
        );
        return updated!;
      });
    },

    /**
     * Serialize a cross-domain command with the Runtime row as its durable
     * fence. The callback runs while that row is locked, so two same-version
     * pause/cancel requests cannot both mutate their source domain. Only after
     * the source side effect returns do we advance the Runtime version and
     * append the command Event/Outbox in the same transaction.
     *
     * A source driver must treat `may_drive=false` as read-only: it may confirm
     * that an earlier crash already applied the requested source state, but it
     * must reject before issuing a new side effect. This preserves recovery
     * from "domain committed, Runtime transaction rolled back" without turning
     * a stale expected_version into authority for a different command.
     */
    async executeRunDomainCommand(
      command: RuntimeRunCommand,
      actorUserId: string,
      effect: (context: RuntimeRunDomainCommandContext) => Promise<void>,
    ): Promise<RuntimeRunDomainCommandResult> {
      const id = assertIdentifier(command.run_id, 'run_id');
      const expectedVersion = assertPositiveInteger(command.expected_version, 'expected_version');
      const idempotencyKey = assertIdentifier(command.idempotency_key, 'idempotency_key');
      const commandFingerprint = fingerprint(command);
      const actor = assertIdentifier(actorUserId, 'actor_user_id');

      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as TransactionalDb;
        const [locked] = await tx.select().from(runtimeRuns).where(eq(runtimeRuns.id, id)).for('update');
        if (!locked) fail('runtime_not_found', `Runtime run ${id} was not found`);

        const [replayed] = await tx
          .select()
          .from(runtimeEvents)
          .where(and(eq(runtimeEvents.run_id, id), eq(runtimeEvents.idempotency_key, idempotencyKey)))
          .limit(1);
        if (replayed) {
          const payload = parseJson<{
            command_fingerprint?: string;
            command?: RuntimeRunCommand;
            result: RuntimeRunRow;
          }>(replayed.payload);
          const replayFingerprint =
            payload.command_fingerprint ?? (payload.command ? fingerprint(payload.command) : undefined);
          if (replayFingerprint !== commandFingerprint) {
            fail('runtime_idempotency_conflict', 'Runtime command idempotency key was reused with different input');
          }
          return { run: payload.result, idempotent: true };
        }

        const mayDrive =
          locked.version === expectedVersion &&
          isRuntimeRunCommandLegal(locked.status, command.type, locked.desired_state);
        await effect({ run: locked, may_drive: mayDrive });

        const at = nowIso();
        const [updated] = await tx
          .update(runtimeRuns)
          .set({
            desired_state: desiredStateForCommand(command.type),
            updated_at: at,
            version: sql`${runtimeRuns.version} + 1`,
          })
          .where(and(eq(runtimeRuns.id, id), eq(runtimeRuns.version, locked.version)))
          .returning();
        if (!updated) fail('runtime_version_conflict', `Runtime run ${id} changed concurrently`);

        await appendEventInTransaction(
          tx,
          {
            run_id: id,
            type: 'run.domain_commanded',
            payload: {
              command_fingerprint: commandFingerprint,
              command,
              result: updated!,
            } as unknown as RuntimePayload,
            actor_user_id: actor,
            idempotency_key: idempotencyKey,
          },
          at,
        );
        return { run: updated!, idempotent: false };
      });
    },

    async claimNextRun(input: RuntimeRunClaimInput): Promise<RuntimeRunRow | undefined> {
      const workerId = assertIdentifier(input.worker_id, 'worker_id');
      const runId = input.run_id ? assertIdentifier(input.run_id, 'run_id') : null;
      const at = asIso(input.at);
      const expiresAt = leaseExpiry(at, input.lease_ms);
      const kinds = input.kinds ? [...new Set(input.kinds)] : null;
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as TransactionalDb;
        const where = and(
          eq(runtimeRuns.status, 'queued'),
          eq(runtimeRuns.desired_state, 'run'),
          or(isNull(runtimeRuns.not_before), lte(runtimeRuns.not_before, at)),
          or(isNull(runtimeRuns.deadline_at), gt(runtimeRuns.deadline_at, at)),
          // A lease that expired while still `claimed` never crossed the
          // driver's provider/side-effect boundary. The reaper marks that
          // narrow case so it can be claimed again even when max_attempts=1;
          // a stale `running` lease is never granted this exception.
          or(
            sql`${runtimeRuns.attempt} < ${runtimeRuns.max_attempts}`,
            eq(runtimeRuns.error_code, SAFE_CLAIM_RECOVERY_CODE),
          ),
          ...(runId ? [eq(runtimeRuns.id, runId)] : []),
          ...(kinds && kinds.length > 0 ? [inArray(runtimeRuns.kind, kinds)] : []),
        );
        const [candidate] = await tx
          .select()
          .from(runtimeRuns)
          .where(where)
          .orderBy(desc(runtimeRuns.priority), asc(runtimeRuns.created_at), asc(runtimeRuns.id))
          .limit(1)
          .for('update', { skipLocked: true });
        if (!candidate) return undefined;
        const [claimed] = await tx
          .update(runtimeRuns)
          .set({
            status: 'claimed',
            lease_owner: workerId,
            lease_expires_at: expiresAt,
            heartbeat_at: at,
            attempt: sql`${runtimeRuns.attempt} + 1`,
            error_code: null,
            error_message: null,
            started_at: candidate.started_at ?? at,
            updated_at: at,
            version: sql`${runtimeRuns.version} + 1`,
          })
          .where(and(eq(runtimeRuns.id, candidate.id), eq(runtimeRuns.version, candidate.version)))
          .returning();
        if (!claimed) return undefined;
        await appendEventInTransaction(
          tx,
          {
            run_id: candidate.id,
            type: 'run.status_changed',
            payload: { from: 'queued', to: 'claimed', lease_owner: workerId, version: claimed!.version },
            idempotency_key: `claim:${claimed!.attempt}:${workerId}`,
          },
          at,
        );
        return claimed!;
      });
    },

    /**
     * Atomically claim one exact queued Run and its exact queued Step. Inline
     * sync execution uses this so a background worker cannot claim the Run in
     * the gap before the caller claims the Step.
     */
    async claimExecution(input: RuntimeExecutionClaimInput): Promise<RuntimeExecutionClaimResult | undefined> {
      const runId = assertIdentifier(input.run_id, 'run_id');
      const stepId = assertIdentifier(input.step_id, 'step_id');
      const workerId = assertIdentifier(input.worker_id, 'worker_id');
      const at = asIso(input.at);
      const expiresAt = leaseExpiry(at, input.lease_ms);
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as TransactionalDb;
        const [run] = await tx.select().from(runtimeRuns).where(eq(runtimeRuns.id, runId)).for('update');
        if (!run) fail('runtime_not_found', `Runtime run ${runId} was not found`);
        const [step] = await tx
          .select()
          .from(runtimeSteps)
          .where(and(eq(runtimeSteps.id, stepId), eq(runtimeSteps.run_id, runId)))
          .for('update');
        if (!step) fail('runtime_not_found', `Runtime step ${stepId} was not found`);
        if (
          run.status !== 'queued' ||
          run.desired_state !== 'run' ||
          run.attempt >= run.max_attempts ||
          step.status !== 'queued' ||
          (run.not_before && Date.parse(run.not_before) > Date.parse(at)) ||
          (run.deadline_at && Date.parse(run.deadline_at) <= Date.parse(at))
        ) {
          return undefined;
        }
        const [claimedRun] = await tx
          .update(runtimeRuns)
          .set({
            status: 'claimed',
            lease_owner: workerId,
            lease_expires_at: expiresAt,
            heartbeat_at: at,
            attempt: sql`${runtimeRuns.attempt} + 1`,
            started_at: run.started_at ?? at,
            updated_at: at,
            version: sql`${runtimeRuns.version} + 1`,
          })
          .where(and(eq(runtimeRuns.id, run.id), eq(runtimeRuns.version, run.version)))
          .returning();
        const [claimedStep] = await tx
          .update(runtimeSteps)
          .set({
            status: 'claimed',
            lease_owner: workerId,
            lease_expires_at: expiresAt,
            heartbeat_at: at,
            started_at: step.started_at ?? at,
            updated_at: at,
            version: sql`${runtimeSteps.version} + 1`,
          })
          .where(and(eq(runtimeSteps.id, step.id), eq(runtimeSteps.version, step.version)))
          .returning();
        if (!claimedRun || !claimedStep) {
          fail('runtime_version_conflict', `Runtime execution ${runId}/${stepId} changed concurrently`);
        }
        await appendEventInTransaction(
          tx,
          {
            run_id: run.id,
            type: 'run.status_changed',
            payload: { from: 'queued', to: 'claimed', lease_owner: workerId, version: claimedRun.version },
            idempotency_key: `claim:${claimedRun.attempt}:${workerId}`,
          },
          at,
        );
        await appendEventInTransaction(
          tx,
          {
            run_id: run.id,
            step_id: step.id,
            type: 'step.status_changed',
            payload: { from: 'queued', to: 'claimed', lease_owner: workerId, version: claimedStep.version },
            idempotency_key: `step.claim:${step.id}:${workerId}:${claimedStep.version}`,
          },
          at,
        );
        return { run: claimedRun, step: claimedStep };
      });
    },

    async heartbeatRun(input: {
      id: string;
      expected_version: number;
      worker_id: string;
      lease_ms: number;
      at?: string | Date;
    }): Promise<RuntimeRunRow> {
      const id = assertIdentifier(input.id, 'id');
      const expectedVersion = assertPositiveInteger(input.expected_version, 'expected_version');
      const workerId = assertIdentifier(input.worker_id, 'worker_id');
      const at = asIso(input.at);
      const expiresAt = leaseExpiry(at, input.lease_ms);
      const eventKey = `run.heartbeat:${expectedVersion}:${workerId}`;
      const commandFingerprint = fingerprint({
        id,
        expected_version: expectedVersion,
        worker_id: workerId,
        lease_ms: input.lease_ms,
      });
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as TransactionalDb;
        const [locked] = await tx.select().from(runtimeRuns).where(eq(runtimeRuns.id, id)).for('update');
        if (!locked) fail('runtime_not_found', `Runtime run ${id} was not found`);
        const [replayed] = await tx
          .select()
          .from(runtimeEvents)
          .where(and(eq(runtimeEvents.run_id, id), eq(runtimeEvents.idempotency_key, eventKey)))
          .limit(1);
        if (replayed) return replayCommand<RuntimeRunRow>(replayed, commandFingerprint);
        if (
          locked.version !== expectedVersion ||
          locked.lease_owner !== workerId ||
          !LEASED_RUN_STATUSES.includes(locked.status as (typeof LEASED_RUN_STATUSES)[number]) ||
          locked.desired_state !== 'run' ||
          !locked.lease_expires_at ||
          Date.parse(locked.lease_expires_at) <= Date.parse(at)
        ) {
          fail('runtime_lease_lost', `Runtime run ${id} lease is no longer owned by this worker`);
        }
        const [updated] = await tx
          .update(runtimeRuns)
          .set({
            heartbeat_at: at,
            lease_expires_at: expiresAt,
            updated_at: at,
            version: sql`${runtimeRuns.version} + 1`,
          })
          .where(
            and(
              eq(runtimeRuns.id, id),
              eq(runtimeRuns.version, expectedVersion),
              eq(runtimeRuns.lease_owner, workerId),
              inArray(runtimeRuns.status, [...LEASED_RUN_STATUSES]),
              eq(runtimeRuns.desired_state, 'run'),
              gt(runtimeRuns.lease_expires_at, at),
            ),
          )
          .returning();
        if (!updated) fail('runtime_lease_lost', `Runtime run ${id} lease is no longer owned by this worker`);
        await appendEventInTransaction(
          tx,
          {
            run_id: id,
            type: 'run.heartbeat',
            payload: { command_fingerprint: commandFingerprint, result: updated! } as unknown as RuntimePayload,
            idempotency_key: eventKey,
          },
          at,
        );
        return updated!;
      });
    },

    async reclaimStaleRuns(at: string | Date = new Date(), limit = 50): Promise<RuntimeRunRow[]> {
      const now = asIso(at);
      const reclaimed: RuntimeRunRow[] = [];
      for (let index = 0; index < Math.min(Math.max(limit, 1), 200); index += 1) {
        const row = await db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as TransactionalDb;
          const [stale] = await tx
            .select()
            .from(runtimeRuns)
            .where(and(inArray(runtimeRuns.status, [...LEASED_RUN_STATUSES]), lte(runtimeRuns.lease_expires_at, now)))
            .orderBy(asc(runtimeRuns.lease_expires_at), asc(runtimeRuns.id))
            .limit(1)
            .for('update', { skipLocked: true });
          if (!stale) return undefined;
          const cancelRequested = stale.desired_state === 'cancel';
          // A claim that never entered `running` is safe to retry once past the
          // configured execution-attempt budget. Keep that exception bounded:
          // a persistently unhealthy worker must eventually fail closed instead
          // of cycling a queued Run forever without operator visibility.
          const safeToReclaim = stale.status === 'claimed' && !cancelRequested && stale.attempt <= stale.max_attempts;
          // Replay policy is expressed by max_attempts at admission. Eval uses
          // additional attempts because each case has an explicit immutable
          // checkpoint; side-effectful Automation/Subagent Runs set max=1 and
          // therefore still fail immediately after a stale running lease.
          const exhausted = stale.attempt >= stale.max_attempts;
          const nextStatus = cancelRequested ? 'canceled' : safeToReclaim ? 'queued' : exhausted ? 'failed' : 'queued';
          const terminal = nextStatus === 'failed' || nextStatus === 'canceled';
          const [updated] = await tx
            .update(runtimeRuns)
            .set({
              status: nextStatus,
              error_code: cancelRequested
                ? 'runtime_cancel_requested'
                : safeToReclaim
                  ? SAFE_CLAIM_RECOVERY_CODE
                  : exhausted
                    ? 'runtime_attempts_exhausted'
                    : stale.error_code,
              error_message: cancelRequested
                ? 'Runtime cancellation was finalized after its worker lease expired'
                : safeToReclaim
                  ? 'Runtime worker lease expired before execution entered the running phase'
                  : exhausted
                    ? 'Runtime lease expired after execution entered the running phase'
                    : stale.error_message,
              ended_at: terminal ? now : null,
              lease_owner: null,
              lease_expires_at: null,
              updated_at: now,
              version: sql`${runtimeRuns.version} + 1`,
            })
            .where(and(eq(runtimeRuns.id, stale.id), eq(runtimeRuns.version, stale.version)))
            .returning();
          if (!updated) return undefined;
          if (safeToReclaim) {
            // A claimed Run has not crossed the provider/tool boundary. Release
            // Steps owned by the same dead worker in this transaction so the
            // next claim sees one coherent execution without a projector race.
            await tx
              .update(runtimeSteps)
              .set({
                status: 'queued',
                lease_owner: null,
                lease_expires_at: null,
                error_code: SAFE_CLAIM_RECOVERY_CODE,
                error_message: 'Parent Runtime claim expired before execution entered running',
                updated_at: now,
                version: sql`${runtimeSteps.version} + 1`,
              })
              .where(
                and(
                  eq(runtimeSteps.run_id, stale.id),
                  eq(runtimeSteps.status, 'claimed'),
                  ...(stale.lease_owner ? [eq(runtimeSteps.lease_owner, stale.lease_owner)] : []),
                ),
              );
          }
          await appendEventInTransaction(
            tx,
            {
              run_id: stale.id,
              type: 'run.lease_expired',
              payload: { result: updated!, previous_lease_owner: stale.lease_owner } as unknown as RuntimePayload,
              idempotency_key: `lease-expired:${stale.attempt}`,
            },
            now,
          );
          return updated!;
        });
        if (!row) break;
        reclaimed.push(row);
      }
      return reclaimed;
    },

    // ─── Steps ───────────────────────────────────────────

    async createStep(input: RuntimeStepCreateInput): Promise<RuntimeStepRow> {
      const id = input.id ? assertIdentifier(input.id, 'id') : prefixedId('rts');
      const runId = assertIdentifier(input.run_id, 'run_id');
      const stepKey = assertIdentifier(input.step_key, 'step_key');
      const attempt = assertPositiveInteger(input.attempt ?? 1, 'attempt');
      const encodedInput = encodeJson(input.input, 'step input');
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as TransactionalDb;
        const lockKey = `runtime-step:${runId}:${stepKey}:${attempt}`;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
        const [existing] = await tx
          .select()
          .from(runtimeSteps)
          .where(
            and(eq(runtimeSteps.run_id, runId), eq(runtimeSteps.step_key, stepKey), eq(runtimeSteps.attempt, attempt)),
          )
          .limit(1);
        if (existing) {
          if (
            (input.id !== undefined && existing.id !== id) ||
            existing.parent_step_id !== (input.parent_step_id ?? null) ||
            existing.kind !== input.kind ||
            existing.input !== encodedInput
          ) {
            fail('runtime_idempotency_conflict', 'Runtime step identity was reused with different input');
          }
          return existing;
        }
        if (input.parent_step_id) {
          await requireStepInRun(tx, runId, input.parent_step_id, 'parent_step_id');
        }
        const at = nowIso();
        const [created] = await tx
          .insert(runtimeSteps)
          .values({
            id,
            run_id: runId,
            parent_step_id: input.parent_step_id ?? null,
            step_key: stepKey,
            kind: assertIdentifier(input.kind, 'kind'),
            attempt,
            input: encodedInput,
            created_at: at,
            updated_at: at,
          })
          .returning();
        await appendEventInTransaction(
          tx,
          {
            run_id: runId,
            step_id: id,
            type: 'step.created',
            payload: { step: created! } as unknown as RuntimePayload,
            actor_user_id: input.actor_user_id ?? null,
            idempotency_key: input.idempotency_key ?? `step.created:${stepKey}:${attempt}`,
          },
          at,
        );
        return created!;
      });
    },

    async getStep(id: string): Promise<RuntimeStepRow | undefined> {
      const [row] = await db.select().from(runtimeSteps).where(eq(runtimeSteps.id, id)).limit(1);
      return row;
    },

    async listSteps(runId: string): Promise<RuntimeStepRow[]> {
      return db
        .select()
        .from(runtimeSteps)
        .where(eq(runtimeSteps.run_id, assertIdentifier(runId, 'run_id')))
        .orderBy(asc(runtimeSteps.created_at), asc(runtimeSteps.id));
    },

    async claimNextStep(input: RuntimeStepClaimInput): Promise<RuntimeStepRow | undefined> {
      const workerId = assertIdentifier(input.worker_id, 'worker_id');
      const runId = assertIdentifier(input.run_id, 'run_id');
      const stepId = input.step_id ? assertIdentifier(input.step_id, 'step_id') : null;
      const at = asIso(input.at);
      const expiresAt = leaseExpiry(at, input.lease_ms);
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as TransactionalDb;
        const [parentRun] = await tx.select().from(runtimeRuns).where(eq(runtimeRuns.id, runId)).for('update');
        if (!parentRun) fail('runtime_not_found', `Runtime run ${runId} was not found`);
        if (
          parentRun.desired_state !== 'run' ||
          !LEASED_RUN_STATUSES.includes(parentRun.status as (typeof LEASED_RUN_STATUSES)[number]) ||
          parentRun.lease_owner !== workerId ||
          !parentRun.lease_expires_at ||
          Date.parse(parentRun.lease_expires_at) <= Date.parse(at)
        ) {
          return undefined;
        }
        const [candidate] = await tx
          .select()
          .from(runtimeSteps)
          .where(
            and(
              eq(runtimeSteps.status, 'queued'),
              eq(runtimeSteps.run_id, runId),
              ...(stepId ? [eq(runtimeSteps.id, stepId)] : []),
            ),
          )
          .orderBy(asc(runtimeSteps.created_at), asc(runtimeSteps.id))
          .limit(1)
          .for('update', { skipLocked: true });
        if (!candidate) return undefined;
        const [claimed] = await tx
          .update(runtimeSteps)
          .set({
            status: 'claimed',
            lease_owner: workerId,
            lease_expires_at: expiresAt,
            heartbeat_at: at,
            started_at: candidate.started_at ?? at,
            updated_at: at,
            version: sql`${runtimeSteps.version} + 1`,
          })
          .where(and(eq(runtimeSteps.id, candidate.id), eq(runtimeSteps.version, candidate.version)))
          .returning();
        if (!claimed) return undefined;
        await appendEventInTransaction(
          tx,
          {
            run_id: candidate.run_id,
            step_id: candidate.id,
            type: 'step.status_changed',
            payload: { from: 'queued', to: 'claimed', lease_owner: workerId, version: claimed!.version },
            idempotency_key: `step.claim:${candidate.id}:${workerId}:${claimed!.version}`,
          },
          at,
        );
        return claimed!;
      });
    },

    async heartbeatStep(input: {
      id: string;
      expected_version: number;
      worker_id: string;
      lease_ms: number;
      at?: string | Date;
    }): Promise<RuntimeStepRow> {
      const id = assertIdentifier(input.id, 'id');
      const expectedVersion = assertPositiveInteger(input.expected_version, 'expected_version');
      const workerId = assertIdentifier(input.worker_id, 'worker_id');
      const at = asIso(input.at);
      const expiresAt = leaseExpiry(at, input.lease_ms);
      const eventKey = `step.heartbeat:${id}:${expectedVersion}:${workerId}`;
      const commandFingerprint = fingerprint({
        id,
        expected_version: expectedVersion,
        worker_id: workerId,
        lease_ms: input.lease_ms,
      });
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as TransactionalDb;
        const [snapshot] = await tx.select().from(runtimeSteps).where(eq(runtimeSteps.id, id)).limit(1);
        if (!snapshot) fail('runtime_not_found', `Runtime step ${id} was not found`);
        const [run] = await tx.select().from(runtimeRuns).where(eq(runtimeRuns.id, snapshot.run_id)).for('update');
        if (!run) fail('runtime_not_found', `Runtime run ${snapshot.run_id} was not found`);
        const [locked] = await tx.select().from(runtimeSteps).where(eq(runtimeSteps.id, id)).for('update');
        if (!locked) fail('runtime_not_found', `Runtime step ${id} was not found`);
        const [replayed] = await tx
          .select()
          .from(runtimeEvents)
          .where(and(eq(runtimeEvents.run_id, locked.run_id), eq(runtimeEvents.idempotency_key, eventKey)))
          .limit(1);
        if (replayed) return replayCommand<RuntimeStepRow>(replayed, commandFingerprint);
        if (
          run.desired_state !== 'run' ||
          !LEASED_RUN_STATUSES.includes(run.status as (typeof LEASED_RUN_STATUSES)[number]) ||
          run.lease_owner !== workerId ||
          !run.lease_expires_at ||
          Date.parse(run.lease_expires_at) <= Date.parse(at) ||
          locked.version !== expectedVersion ||
          locked.lease_owner !== workerId ||
          !LEASED_STEP_STATUSES.includes(locked.status as (typeof LEASED_STEP_STATUSES)[number]) ||
          !locked.lease_expires_at ||
          Date.parse(locked.lease_expires_at) <= Date.parse(at)
        ) {
          fail('runtime_lease_lost', `Runtime step ${id} lease is no longer owned by this worker`);
        }
        const [updated] = await tx
          .update(runtimeSteps)
          .set({
            heartbeat_at: at,
            lease_expires_at: expiresAt,
            updated_at: at,
            version: sql`${runtimeSteps.version} + 1`,
          })
          .where(
            and(
              eq(runtimeSteps.id, id),
              eq(runtimeSteps.version, expectedVersion),
              eq(runtimeSteps.lease_owner, workerId),
              inArray(runtimeSteps.status, [...LEASED_STEP_STATUSES]),
              gt(runtimeSteps.lease_expires_at, at),
            ),
          )
          .returning();
        if (!updated) fail('runtime_lease_lost', `Runtime step ${id} lease is no longer owned by this worker`);
        await appendEventInTransaction(
          tx,
          {
            run_id: locked.run_id,
            step_id: id,
            type: 'step.heartbeat',
            payload: { command_fingerprint: commandFingerprint, result: updated! } as unknown as RuntimePayload,
            idempotency_key: eventKey,
          },
          at,
        );
        return updated!;
      });
    },

    async listStaleSteps(at: string | Date = new Date(), limit = 100): Promise<RuntimeStepRow[]> {
      const now = asIso(at);
      return db
        .select()
        .from(runtimeSteps)
        .where(and(inArray(runtimeSteps.status, [...LEASED_STEP_STATUSES]), lte(runtimeSteps.lease_expires_at, now)))
        .orderBy(asc(runtimeSteps.lease_expires_at), asc(runtimeSteps.id))
        .limit(Math.min(Math.max(limit, 1), 500));
    },

    async requeueStaleStep(input: RuntimeStepStaleRequeueInput): Promise<RuntimeStepStaleRequeueResult> {
      const id = assertIdentifier(input.id, 'id');
      const expectedVersion = assertPositiveInteger(input.expected_version, 'expected_version');
      const eventKey = assertIdentifier(input.idempotency_key, 'idempotency_key');
      const at = asIso(input.at);
      const commandFingerprint = fingerprint({
        id,
        expected_version: expectedVersion,
        idempotency_key: eventKey,
        checkpoint: input.checkpoint,
      });
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as TransactionalDb;
        const [snapshot] = await tx.select().from(runtimeSteps).where(eq(runtimeSteps.id, id)).limit(1);
        if (!snapshot) fail('runtime_not_found', `Runtime step ${id} was not found`);
        const [run] = await tx.select().from(runtimeRuns).where(eq(runtimeRuns.id, snapshot.run_id)).for('update');
        if (!run) fail('runtime_not_found', `Runtime run ${snapshot.run_id} was not found`);
        const [locked] = await tx.select().from(runtimeSteps).where(eq(runtimeSteps.id, id)).for('update');
        if (!locked) fail('runtime_not_found', `Runtime step ${id} was not found`);
        const [replayed] = await tx
          .select()
          .from(runtimeEvents)
          .where(and(eq(runtimeEvents.run_id, locked.run_id), eq(runtimeEvents.idempotency_key, eventKey)))
          .limit(1);
        if (replayed) return replayCommand<RuntimeStepStaleRequeueResult>(replayed, commandFingerprint);
        if (locked.version !== expectedVersion) {
          fail('runtime_version_conflict', `Runtime step ${id} is at version ${locked.version}`);
        }
        if (
          run.desired_state !== 'run' ||
          !LEASED_RUN_STATUSES.includes(run.status as (typeof LEASED_RUN_STATUSES)[number]) ||
          !LEASED_STEP_STATUSES.includes(locked.status as (typeof LEASED_STEP_STATUSES)[number]) ||
          !locked.lease_expires_at ||
          Date.parse(locked.lease_expires_at) > Date.parse(at)
        ) {
          fail('runtime_invalid_transition', `Runtime step ${id} is not a stale retryable lease`);
        }
        const [interrupted] = await tx
          .update(runtimeSteps)
          .set({
            status: 'interrupted',
            error_code: 'runtime_lease_expired',
            error_message: 'Runtime step lease expired at a driver-declared safe checkpoint',
            ended_at: at,
            lease_owner: null,
            lease_expires_at: null,
            updated_at: at,
            version: sql`${runtimeSteps.version} + 1`,
          })
          .where(and(eq(runtimeSteps.id, id), eq(runtimeSteps.version, expectedVersion)))
          .returning();
        if (!interrupted) fail('runtime_version_conflict', `Runtime step ${id} changed concurrently`);
        const replacementId = prefixedId('rts');
        const [replacement] = await tx
          .insert(runtimeSteps)
          .values({
            id: replacementId,
            run_id: locked.run_id,
            parent_step_id: locked.parent_step_id,
            step_key: locked.step_key,
            kind: locked.kind,
            attempt: locked.attempt + 1,
            input: locked.input,
            created_at: at,
            updated_at: at,
          })
          .returning();
        const result = { interrupted: interrupted!, replacement: replacement! };
        await appendEventInTransaction(
          tx,
          {
            run_id: locked.run_id,
            step_id: id,
            type: 'step.status_changed',
            payload: {
              command_fingerprint: commandFingerprint,
              result,
              checkpoint: input.checkpoint,
            } as unknown as RuntimePayload,
            idempotency_key: eventKey,
          },
          at,
        );
        await appendEventInTransaction(
          tx,
          {
            run_id: locked.run_id,
            step_id: replacementId,
            type: 'step.created',
            payload: {
              step: replacement!,
              replaces_step_id: id,
              checkpoint: input.checkpoint,
            } as unknown as RuntimePayload,
            idempotency_key: `${eventKey}:replacement`,
          },
          at,
        );
        return result;
      });
    },

    async transitionStep(input: RuntimeStepTransitionInput): Promise<RuntimeStepRow> {
      const expectedVersion = assertPositiveInteger(input.expected_version, 'expected_version');
      const eventKey = assertIdentifier(input.idempotency_key, 'idempotency_key');
      const workerId = input.worker_id ? assertIdentifier(input.worker_id, 'worker_id') : null;
      if ((workerId === null) !== (input.lease_ms === undefined)) {
        fail('runtime_invalid_input', 'worker_id and lease_ms must be supplied together');
      }
      const workerTransitionAllowed =
        input.to_status === 'running' ||
        ['succeeded', 'failed', 'canceled', 'interrupted', 'skipped'].includes(input.to_status);
      if (workerId && !workerTransitionAllowed) {
        fail('runtime_invalid_input', 'A live lease fence is only valid when entering running or terminal state');
      }
      if (input.projection_only && (workerId || input.to_status !== 'running')) {
        fail('runtime_invalid_input', 'projection_only is only valid for an unleased transition into running');
      }
      const commandFingerprint = fingerprint({ ...input, actor_user_id: input.actor_user_id ?? null });
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as TransactionalDb;
        const [snapshot] = await tx.select().from(runtimeSteps).where(eq(runtimeSteps.id, input.id)).limit(1);
        if (!snapshot) fail('runtime_not_found', `Runtime step ${input.id} was not found`);
        const [parentRun] = await tx
          .select()
          .from(runtimeRuns)
          .where(eq(runtimeRuns.id, snapshot.run_id))
          .for('update');
        if (!parentRun) fail('runtime_not_found', `Runtime run ${snapshot.run_id} was not found`);
        const [locked] = await tx.select().from(runtimeSteps).where(eq(runtimeSteps.id, input.id)).for('update');
        if (!locked) fail('runtime_not_found', `Runtime step ${input.id} was not found`);
        const [replayed] = await tx
          .select()
          .from(runtimeEvents)
          .where(and(eq(runtimeEvents.run_id, locked.run_id), eq(runtimeEvents.idempotency_key, eventKey)))
          .limit(1);
        if (replayed) return replayCommand<RuntimeStepRow>(replayed, commandFingerprint);
        if (locked.version !== expectedVersion) {
          fail('runtime_version_conflict', `Runtime step ${input.id} is at version ${locked.version}`);
        }
        if (!canTransitionRuntimeStep(locked.status, input.to_status)) {
          fail(
            'runtime_invalid_transition',
            `Cannot transition runtime step from ${locked.status} to ${input.to_status}`,
          );
        }
        if (
          input.to_status === 'running' &&
          !workerId &&
          !input.projection_only &&
          (parentRun.kind === 'eval' || parentRun.kind === 'automation' || parentRun.kind === 'subagent')
        ) {
          fail('runtime_lease_lost', `Runtime ${parentRun.kind} step ${input.id} requires a live driver claim`);
        }
        const at = nowIso();
        const terminal = ['succeeded', 'failed', 'canceled', 'interrupted', 'skipped'].includes(input.to_status);
        if (workerId) {
          const desiredMatches =
            input.to_status === 'canceled'
              ? parentRun.desired_state === 'cancel'
              : !terminal || parentRun.desired_state === 'run';
          const stepLeaseRequired = locked.status !== 'queued';
          const validStepStatus =
            input.to_status === 'running'
              ? locked.status === 'claimed'
              : terminal && ['queued', 'claimed', 'running', 'waiting'].includes(locked.status);
          if (
            !desiredMatches ||
            !validStepStatus ||
            !LEASED_RUN_STATUSES.includes(parentRun.status as (typeof LEASED_RUN_STATUSES)[number]) ||
            parentRun.lease_owner !== workerId ||
            !parentRun.lease_expires_at ||
            Date.parse(parentRun.lease_expires_at) <= Date.parse(at) ||
            (stepLeaseRequired &&
              (locked.lease_owner !== workerId ||
                !locked.lease_expires_at ||
                Date.parse(locked.lease_expires_at) <= Date.parse(at)))
          ) {
            fail('runtime_lease_lost', `Runtime step ${input.id} no longer has terminal authority for ${workerId}`);
          }
        }
        const renewedLease = workerId && input.to_status === 'running' ? leaseExpiry(at, input.lease_ms!) : null;
        const releasesLease = terminal || ['queued', 'waiting', 'paused'].includes(input.to_status);
        const [updated] = await tx
          .update(runtimeSteps)
          .set({
            status: input.to_status,
            ...(input.output !== undefined
              ? { output: input.output === null ? null : encodeJson(input.output, 'step output') }
              : {}),
            ...(input.error_code !== undefined ? { error_code: input.error_code } : {}),
            ...(input.error_message !== undefined ? { error_message: input.error_message } : {}),
            ...(input.tokens_used !== undefined
              ? { tokens_used: assertNonnegativeInteger(input.tokens_used, 'tokens_used') }
              : {}),
            ...(input.requests_used !== undefined
              ? { requests_used: assertNonnegativeInteger(input.requests_used, 'requests_used') }
              : {}),
            ...(input.cost_micros !== undefined
              ? { cost_micros: assertNonnegativeInteger(input.cost_micros, 'cost_micros') }
              : {}),
            ...(input.duration_ms !== undefined
              ? {
                  duration_ms:
                    input.duration_ms === null ? null : assertNonnegativeInteger(input.duration_ms, 'duration_ms'),
                }
              : {}),
            ...(input.to_status === 'running' && !locked.started_at ? { started_at: at } : {}),
            ...(renewedLease ? { lease_expires_at: renewedLease, heartbeat_at: at } : {}),
            ...(releasesLease ? { lease_owner: null, lease_expires_at: null } : {}),
            ...(terminal ? { ended_at: at } : {}),
            updated_at: at,
            version: sql`${runtimeSteps.version} + 1`,
          })
          .where(and(eq(runtimeSteps.id, input.id), eq(runtimeSteps.version, expectedVersion)))
          .returning();
        if (!updated) fail('runtime_version_conflict', `Runtime step ${input.id} changed concurrently`);
        await appendEventInTransaction(
          tx,
          {
            run_id: locked.run_id,
            step_id: locked.id,
            type: 'step.status_changed',
            payload: { command_fingerprint: commandFingerprint, result: updated! } as unknown as RuntimePayload,
            actor_user_id: input.actor_user_id ?? null,
            idempotency_key: eventKey,
          },
          at,
        );
        return updated!;
      });
    },

    // ─── Tool calls / artifacts / interrupts ─────────────

    async createToolCall(input: RuntimeToolCallCreateInput): Promise<RuntimeToolCallRow> {
      const id = input.id ? assertIdentifier(input.id, 'id') : prefixedId('rtc');
      const runId = assertIdentifier(input.run_id, 'run_id');
      const stepId = input.step_id ? assertIdentifier(input.step_id, 'step_id') : null;
      const toolName = assertIdentifier(input.tool_name, 'tool_name');
      const canonicalInputHash = assertIdentifier(input.canonical_input_hash, 'canonical_input_hash');
      const idempotencyKey = input.idempotency_key ? assertIdentifier(input.idempotency_key, 'idempotency_key') : null;
      const encodedInput = encodeJson(input.input, 'tool input');
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as TransactionalDb;
        if (stepId) await requireStepInRun(tx, runId, stepId);
        if (idempotencyKey) {
          const lockKey = `runtime-tool:${runId}:${idempotencyKey}`;
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
          const [existing] = await tx
            .select()
            .from(runtimeToolCalls)
            .where(and(eq(runtimeToolCalls.run_id, runId), eq(runtimeToolCalls.idempotency_key, idempotencyKey)))
            .limit(1);
          if (existing) {
            if (
              (input.id !== undefined && existing.id !== id) ||
              existing.step_id !== stepId ||
              existing.tool_name !== toolName ||
              existing.input !== encodedInput ||
              existing.canonical_input_hash !== canonicalInputHash ||
              existing.risk_level !== input.risk_level ||
              existing.platform_audit_event_id !== (input.platform_audit_event_id ?? null)
            ) {
              fail('runtime_idempotency_conflict', 'Runtime tool idempotency key was reused with different input');
            }
            return existing;
          }
        }
        const at = nowIso();
        const [created] = await tx
          .insert(runtimeToolCalls)
          .values({
            id,
            run_id: runId,
            step_id: stepId,
            tool_name: toolName,
            input: encodedInput,
            canonical_input_hash: canonicalInputHash,
            risk_level: input.risk_level,
            idempotency_key: idempotencyKey,
            platform_audit_event_id: input.platform_audit_event_id ?? null,
            created_at: at,
            updated_at: at,
          })
          .returning();
        await appendEventInTransaction(
          tx,
          {
            run_id: runId,
            step_id: stepId,
            type: 'tool.requested',
            payload: { tool_call: created! } as unknown as RuntimePayload,
            actor_user_id: input.actor_user_id ?? null,
            idempotency_key: `tool.requested:${id}`,
          },
          at,
        );
        return created!;
      });
    },

    async beginToolCallWithAuthority(input: RuntimeToolCallBeginInput): Promise<RuntimeToolCallRow> {
      const runId = assertIdentifier(input.run_id, 'run_id');
      const stepId = assertIdentifier(input.step_id, 'step_id');
      const actorUserId = assertIdentifier(input.actor_user_id, 'actor_user_id');
      const idempotencyKey = assertIdentifier(input.idempotency_key, 'idempotency_key');
      const workerId = input.worker_id ? assertIdentifier(input.worker_id, 'worker_id') : null;
      if ((workerId === null) !== (input.lease_ms === undefined)) {
        fail('runtime_invalid_input', 'worker_id and lease_ms must be supplied together');
      }
      if (input.lease_ms !== undefined) assertPositiveInteger(input.lease_ms, 'lease_ms');
      if ((workerId !== null) === (input.projection_only === true)) {
        fail('runtime_invalid_input', 'Exactly one tool execution authority is required');
      }
      const at = asIso(input.at);
      const lockKey = `runtime-tool:${runId}:${idempotencyKey}`;

      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as TransactionalDb;
        // Match createToolCall's lock order so direct evidence writers cannot
        // deadlock this execution admission while both target the same key.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
        const [run] = await tx.select().from(runtimeRuns).where(eq(runtimeRuns.id, runId)).for('update');
        if (!run) fail('runtime_not_found', `Runtime run ${runId} was not found`);
        const [step] = await tx
          .select()
          .from(runtimeSteps)
          .where(and(eq(runtimeSteps.id, stepId), eq(runtimeSteps.run_id, runId)))
          .for('update');
        if (!step) fail('runtime_invalid_input', `step_id does not belong to runtime run ${runId}`);
        if (run.owner_user_id !== actorUserId) {
          fail('runtime_invalid_input', 'Tool actor must be the Runtime owner');
        }

        const parentsRunning = run.desired_state === 'run' && run.status === 'running' && step.status === 'running';
        if (workerId) {
          const runLeaseLive =
            run.lease_owner === workerId &&
            run.lease_expires_at !== null &&
            Date.parse(run.lease_expires_at) > Date.parse(at);
          const stepLeaseLive =
            step.lease_owner === workerId &&
            step.lease_expires_at !== null &&
            Date.parse(step.lease_expires_at) > Date.parse(at);
          if (run.kind === 'chat' || !parentsRunning || !runLeaseLive || !stepLeaseLive) {
            fail('runtime_lease_lost', `Runtime tool call no longer has execution authority for ${workerId}`);
          }
        } else {
          const chatProjection =
            run.kind === 'chat' &&
            run.source_kind === 'chat_turn' &&
            parentsRunning &&
            run.lease_owner === null &&
            run.lease_expires_at === null &&
            step.lease_owner === null &&
            step.lease_expires_at === null;
          if (!chatProjection) {
            fail('runtime_lease_lost', 'Runtime tool projection is no longer an active unleased Chat turn');
          }
        }

        // The Run row lock serializes every begin in this Run. A matching row
        // means an earlier transaction already admitted this SDK toolCallId;
        // never turn a network retry into a second external side effect.
        const [existing] = await tx
          .select({ id: runtimeToolCalls.id, status: runtimeToolCalls.status })
          .from(runtimeToolCalls)
          .where(and(eq(runtimeToolCalls.run_id, runId), eq(runtimeToolCalls.idempotency_key, idempotencyKey)))
          .limit(1);
        if (existing) {
          fail(
            'runtime_idempotency_conflict',
            `Runtime tool call ${existing.id} was already admitted as ${existing.status}`,
          );
        }

        // Nested service transactions are savepoints. The parent authority
        // locks stay held until both evidence events and the running row commit.
        const nested = createRuntimeService(tx);
        const created = await nested.createToolCall(input);
        return nested.transitionToolCall({
          id: created.id,
          expected_version: created.version,
          to_status: 'running',
          event_idempotency_key: `${idempotencyKey}:running`,
          actor_user_id: actorUserId,
        });
      });
    },

    async getToolCall(id: string): Promise<RuntimeToolCallRow | undefined> {
      const [row] = await db
        .select()
        .from(runtimeToolCalls)
        .where(eq(runtimeToolCalls.id, assertIdentifier(id, 'id')))
        .limit(1);
      return row;
    },

    async listToolCalls(runId: string): Promise<RuntimeToolCallRow[]> {
      return db
        .select()
        .from(runtimeToolCalls)
        .where(eq(runtimeToolCalls.run_id, assertIdentifier(runId, 'run_id')))
        .orderBy(asc(runtimeToolCalls.created_at), asc(runtimeToolCalls.id));
    },

    async transitionToolCall(input: RuntimeToolCallTransitionInput): Promise<RuntimeToolCallRow> {
      const commandFingerprint = fingerprint({ ...input, actor_user_id: input.actor_user_id ?? null });
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as TransactionalDb;
        const [locked] = await tx
          .select()
          .from(runtimeToolCalls)
          .where(eq(runtimeToolCalls.id, input.id))
          .for('update');
        if (!locked) fail('runtime_not_found', `Runtime tool call ${input.id} was not found`);
        const [replayed] = await tx
          .select()
          .from(runtimeEvents)
          .where(
            and(
              eq(runtimeEvents.run_id, locked.run_id),
              eq(runtimeEvents.idempotency_key, input.event_idempotency_key),
            ),
          )
          .limit(1);
        if (replayed) return replayCommand<RuntimeToolCallRow>(replayed, commandFingerprint);
        if (locked.version !== input.expected_version) {
          fail('runtime_version_conflict', `Runtime tool call ${input.id} is at version ${locked.version}`);
        }
        if (!canTransitionRuntimeToolCall(locked.status, input.to_status)) {
          fail('runtime_invalid_transition', `Cannot transition tool call from ${locked.status} to ${input.to_status}`);
        }
        const at = nowIso();
        const terminal = ['succeeded', 'failed', 'canceled'].includes(input.to_status);
        const [updated] = await tx
          .update(runtimeToolCalls)
          .set({
            status: input.to_status,
            ...(input.output !== undefined
              ? { output: input.output === null ? null : encodeJson(input.output, 'tool output') }
              : {}),
            ...(input.error_code !== undefined ? { error_code: input.error_code } : {}),
            ...(input.error_message !== undefined ? { error_message: input.error_message } : {}),
            ...(input.to_status === 'running' && !locked.started_at ? { started_at: at } : {}),
            ...(terminal ? { ended_at: at } : {}),
            updated_at: at,
            version: sql`${runtimeToolCalls.version} + 1`,
          })
          .where(and(eq(runtimeToolCalls.id, input.id), eq(runtimeToolCalls.version, input.expected_version)))
          .returning();
        if (!updated) fail('runtime_version_conflict', `Runtime tool call ${input.id} changed concurrently`);
        await appendEventInTransaction(
          tx,
          {
            run_id: locked.run_id,
            step_id: locked.step_id,
            type: 'tool.status_changed',
            payload: { command_fingerprint: commandFingerprint, result: updated! } as unknown as RuntimePayload,
            actor_user_id: input.actor_user_id ?? null,
            idempotency_key: input.event_idempotency_key,
          },
          at,
        );
        return updated!;
      });
    },

    async createArtifact(input: RuntimeArtifactCreateInput): Promise<RuntimeArtifactRow> {
      if (input.size_bytes !== undefined && input.size_bytes !== null) {
        assertNonnegativeInteger(input.size_bytes, 'size_bytes');
      }
      const id = input.id ? assertIdentifier(input.id, 'id') : prefixedId('rta');
      const runId = assertIdentifier(input.run_id, 'run_id');
      const stepId = input.step_id ? assertIdentifier(input.step_id, 'step_id') : null;
      const toolCallId = input.tool_call_id ? assertIdentifier(input.tool_call_id, 'tool_call_id') : null;
      const eventKey = input.idempotency_key
        ? assertIdentifier(input.idempotency_key, 'idempotency_key')
        : `artifact.created:${id}`;
      const commandFingerprint = fingerprint({
        ...(input.id !== undefined ? { id } : {}),
        run_id: runId,
        step_id: stepId,
        tool_call_id: toolCallId,
        direction: input.direction,
        kind: input.kind,
        name: input.name,
        path: input.path ?? null,
        content_type: input.content_type ?? null,
        size_bytes: input.size_bytes ?? null,
        sha256: input.sha256 ?? null,
        storage_key: input.storage_key ?? null,
        status: input.status ?? 'pending',
        source: input.source,
        actor_user_id: input.actor_user_id ?? null,
      });
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as TransactionalDb;
        const lockKey = `runtime-artifact:${runId}:${eventKey}`;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
        const [replayed] = await tx
          .select()
          .from(runtimeEvents)
          .where(and(eq(runtimeEvents.run_id, runId), eq(runtimeEvents.idempotency_key, eventKey)))
          .limit(1);
        if (replayed) return replayCommand<RuntimeArtifactRow>(replayed, commandFingerprint);
        const step = stepId ? await requireStepInRun(tx, runId, stepId) : null;
        const toolCall = toolCallId ? await requireToolCallInRun(tx, runId, toolCallId) : null;
        if (step && toolCall?.step_id && toolCall.step_id !== step.id) {
          fail('runtime_invalid_input', 'tool_call_id and step_id belong to different runtime steps');
        }
        const at = nowIso();
        const [created] = await tx
          .insert(runtimeArtifacts)
          .values({
            id,
            run_id: runId,
            step_id: stepId,
            tool_call_id: toolCallId,
            direction: input.direction,
            kind: assertIdentifier(input.kind, 'kind'),
            name: assertIdentifier(input.name, 'name', 2048),
            path: input.path ?? null,
            content_type: input.content_type ?? null,
            size_bytes: input.size_bytes ?? null,
            sha256: input.sha256 ?? null,
            storage_key: input.storage_key ?? null,
            status: input.status ?? 'pending',
            source: assertIdentifier(input.source, 'source'),
            created_at: at,
            updated_at: at,
          })
          .returning();
        await appendEventInTransaction(
          tx,
          {
            run_id: runId,
            step_id: stepId,
            type: 'artifact.created',
            payload: { command_fingerprint: commandFingerprint, result: created! } as unknown as RuntimePayload,
            actor_user_id: input.actor_user_id ?? null,
            idempotency_key: eventKey,
          },
          at,
        );
        return created!;
      });
    },

    async getArtifact(id: string): Promise<RuntimeArtifactRow | undefined> {
      const [row] = await db
        .select()
        .from(runtimeArtifacts)
        .where(eq(runtimeArtifacts.id, assertIdentifier(id, 'id')))
        .limit(1);
      return row;
    },

    async listArtifacts(runId: string): Promise<RuntimeArtifactRow[]> {
      return db
        .select()
        .from(runtimeArtifacts)
        .where(eq(runtimeArtifacts.run_id, assertIdentifier(runId, 'run_id')))
        .orderBy(asc(runtimeArtifacts.created_at), asc(runtimeArtifacts.id));
    },

    async transitionArtifact(input: {
      id: string;
      expected_status: RuntimeArtifactStatus;
      to_status: RuntimeArtifactStatus;
      idempotency_key: string;
      storage_key?: string | null;
      sha256?: string | null;
      size_bytes?: number | null;
      actor_user_id?: string | null;
    }): Promise<RuntimeArtifactRow> {
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as TransactionalDb;
        const [locked] = await tx
          .select()
          .from(runtimeArtifacts)
          .where(eq(runtimeArtifacts.id, input.id))
          .for('update');
        if (!locked) fail('runtime_not_found', `Runtime artifact ${input.id} was not found`);
        const [existingEvent] = await tx
          .select()
          .from(runtimeEvents)
          .where(and(eq(runtimeEvents.run_id, locked.run_id), eq(runtimeEvents.idempotency_key, input.idempotency_key)))
          .limit(1);
        const commandFingerprint = fingerprint({ ...input, actor_user_id: input.actor_user_id ?? null });
        if (existingEvent) return replayCommand<RuntimeArtifactRow>(existingEvent, commandFingerprint);
        if (locked.status !== input.expected_status || !canTransitionRuntimeArtifact(locked.status, input.to_status)) {
          fail('runtime_invalid_transition', `Cannot transition artifact from ${locked.status} to ${input.to_status}`);
        }
        if (input.size_bytes !== undefined && input.size_bytes !== null) {
          assertNonnegativeInteger(input.size_bytes, 'size_bytes');
        }
        const at = nowIso();
        const [updated] = await tx
          .update(runtimeArtifacts)
          .set({
            status: input.to_status,
            ...(input.storage_key !== undefined ? { storage_key: input.storage_key } : {}),
            ...(input.sha256 !== undefined ? { sha256: input.sha256 } : {}),
            ...(input.size_bytes !== undefined ? { size_bytes: input.size_bytes } : {}),
            updated_at: at,
          })
          .where(and(eq(runtimeArtifacts.id, input.id), eq(runtimeArtifacts.status, input.expected_status)))
          .returning();
        if (!updated) fail('runtime_version_conflict', `Runtime artifact ${input.id} changed concurrently`);
        await appendEventInTransaction(
          tx,
          {
            run_id: locked.run_id,
            step_id: locked.step_id,
            type: 'artifact.status_changed',
            payload: { command_fingerprint: commandFingerprint, result: updated! } as unknown as RuntimePayload,
            actor_user_id: input.actor_user_id ?? null,
            idempotency_key: input.idempotency_key,
          },
          at,
        );
        return updated!;
      });
    },

    async createInterrupt(input: RuntimeInterruptCreateInput): Promise<RuntimeInterruptRow> {
      const id = input.id ? assertIdentifier(input.id, 'id') : prefixedId('rti');
      const runId = assertIdentifier(input.run_id, 'run_id');
      const stepId = input.step_id ? assertIdentifier(input.step_id, 'step_id') : null;
      const toolCallId = input.tool_call_id ? assertIdentifier(input.tool_call_id, 'tool_call_id') : null;
      const eventKey = input.idempotency_key
        ? assertIdentifier(input.idempotency_key, 'idempotency_key')
        : `interrupt.created:${id}`;
      const payload = encodeJson(input.payload, 'interrupt payload');
      const expiresAt = input.expires_at ? asIso(input.expires_at, 'expires_at') : null;
      const assigneeUserId = assertIdentifier(input.assignee_user_id, 'assignee_user_id');
      const commandFingerprint = fingerprint({
        ...(input.id !== undefined ? { id } : {}),
        run_id: runId,
        step_id: stepId,
        tool_call_id: toolCallId,
        kind: input.kind,
        payload: input.payload,
        canonical_input_hash: input.canonical_input_hash ?? null,
        risk_level: input.risk_level ?? null,
        assignee_user_id: assigneeUserId,
        expires_at: expiresAt,
        actor_user_id: input.actor_user_id ?? null,
      });
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as TransactionalDb;
        const lockKey = `runtime-interrupt:${runId}:${eventKey}`;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
        const [replayed] = await tx
          .select()
          .from(runtimeEvents)
          .where(and(eq(runtimeEvents.run_id, runId), eq(runtimeEvents.idempotency_key, eventKey)))
          .limit(1);
        if (replayed) return replayCommand<RuntimeInterruptRow>(replayed, commandFingerprint);
        const step = stepId ? await requireStepInRun(tx, runId, stepId) : null;
        const toolCall = toolCallId ? await requireToolCallInRun(tx, runId, toolCallId) : null;
        if (step && toolCall?.step_id && toolCall.step_id !== step.id) {
          fail('runtime_invalid_input', 'tool_call_id and step_id belong to different runtime steps');
        }
        if (toolCall?.interrupt_id) {
          fail('runtime_invalid_transition', `Runtime tool call ${toolCall.id} already has an interrupt`);
        }
        const at = nowIso();
        const [created] = await tx
          .insert(runtimeInterrupts)
          .values({
            id,
            run_id: runId,
            step_id: stepId,
            tool_call_id: toolCallId,
            kind: input.kind,
            payload,
            canonical_input_hash: input.canonical_input_hash ?? null,
            risk_level: input.risk_level ?? null,
            assignee_user_id: assigneeUserId,
            expires_at: expiresAt,
            created_at: at,
            updated_at: at,
          })
          .returning();
        if (toolCallId) {
          const [linked] = await tx
            .update(runtimeToolCalls)
            .set({ interrupt_id: id, updated_at: at, version: sql`${runtimeToolCalls.version} + 1` })
            .where(
              and(
                eq(runtimeToolCalls.id, toolCallId),
                eq(runtimeToolCalls.run_id, runId),
                isNull(runtimeToolCalls.interrupt_id),
              ),
            )
            .returning({ id: runtimeToolCalls.id });
          if (!linked) fail('runtime_version_conflict', `Runtime tool call ${toolCallId} changed concurrently`);
        }
        await appendEventInTransaction(
          tx,
          {
            run_id: runId,
            step_id: stepId,
            type: 'interrupt.created',
            payload: { command_fingerprint: commandFingerprint, result: created! } as unknown as RuntimePayload,
            actor_user_id: input.actor_user_id ?? null,
            idempotency_key: eventKey,
          },
          at,
        );
        return created!;
      });
    },

    async getInterrupt(id: string): Promise<RuntimeInterruptRow | undefined> {
      const [row] = await db
        .select()
        .from(runtimeInterrupts)
        .where(eq(runtimeInterrupts.id, assertIdentifier(id, 'id')))
        .limit(1);
      return row;
    },

    async listInterrupts(runId: string): Promise<RuntimeInterruptRow[]> {
      return db
        .select()
        .from(runtimeInterrupts)
        .where(eq(runtimeInterrupts.run_id, assertIdentifier(runId, 'run_id')))
        .orderBy(asc(runtimeInterrupts.created_at), asc(runtimeInterrupts.id));
    },

    async commandInterrupt(command: RuntimeInterruptCommand, decidedByUserId: string): Promise<RuntimeInterruptRow> {
      const commandFingerprint = fingerprint(command);
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as TransactionalDb;
        const [locked] = await tx
          .select()
          .from(runtimeInterrupts)
          .where(eq(runtimeInterrupts.id, command.interrupt_id))
          .for('update');
        if (!locked) fail('runtime_not_found', `Runtime interrupt ${command.interrupt_id} was not found`);
        const [replayed] = await tx
          .select()
          .from(runtimeEvents)
          .where(
            and(eq(runtimeEvents.run_id, locked.run_id), eq(runtimeEvents.idempotency_key, command.idempotency_key)),
          )
          .limit(1);
        if (replayed) return replayCommand<RuntimeInterruptRow>(replayed, commandFingerprint);
        if (locked.version !== command.expected_version) {
          fail('runtime_version_conflict', `Runtime interrupt ${command.interrupt_id} is at version ${locked.version}`);
        }
        if (!isRuntimeInterruptCommandLegal(locked.status, command.type)) {
          fail('runtime_invalid_transition', `Command ${command.type} is not legal for interrupt ${locked.status}`);
        }
        if (locked.expires_at && Date.parse(locked.expires_at) <= Date.now()) {
          fail('runtime_invalid_transition', 'Runtime interrupt has expired');
        }
        const at = nowIso();
        const status = command.type === 'resolve' ? 'resolved' : command.type === 'reject' ? 'rejected' : 'canceled';
        if (!canTransitionRuntimeInterrupt(locked.status, status)) {
          fail('runtime_invalid_transition', `Cannot transition interrupt from ${locked.status} to ${status}`);
        }
        const [updated] = await tx
          .update(runtimeInterrupts)
          .set({
            status,
            decision: command.decision === null ? null : encodeJson(command.decision, 'interrupt decision'),
            decided_by_user_id: assertIdentifier(decidedByUserId, 'decided_by_user_id'),
            decided_at: at,
            updated_at: at,
            version: sql`${runtimeInterrupts.version} + 1`,
          })
          .where(
            and(
              eq(runtimeInterrupts.id, command.interrupt_id),
              eq(runtimeInterrupts.version, command.expected_version),
            ),
          )
          .returning();
        if (!updated)
          fail('runtime_version_conflict', `Runtime interrupt ${command.interrupt_id} changed concurrently`);
        await appendEventInTransaction(
          tx,
          {
            run_id: locked.run_id,
            step_id: locked.step_id,
            type: 'interrupt.status_changed',
            payload: { command_fingerprint: commandFingerprint, result: updated! } as unknown as RuntimePayload,
            actor_user_id: decidedByUserId,
            idempotency_key: command.idempotency_key,
          },
          at,
        );
        return updated!;
      });
    },

    async listPendingInterrupts(assigneeUserId: string, limit = 100): Promise<RuntimeInterruptRow[]> {
      return db
        .select()
        .from(runtimeInterrupts)
        .where(
          and(
            eq(runtimeInterrupts.assignee_user_id, assigneeUserId),
            eq(runtimeInterrupts.status, 'pending'),
            or(isNull(runtimeInterrupts.expires_at), gt(runtimeInterrupts.expires_at, nowIso())),
          ),
        )
        .orderBy(asc(runtimeInterrupts.created_at), asc(runtimeInterrupts.id))
        .limit(Math.min(Math.max(limit, 1), 200));
    },

    async listInterruptsPage(input: RuntimeInterruptListInput = {}): Promise<RuntimeInterruptListResult> {
      const assigneeUserId = input.assignee_user_id
        ? assertIdentifier(input.assignee_user_id, 'assignee_user_id')
        : null;
      const kinds = input.kinds ? [...new Set(input.kinds)] : null;
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
      const cursor = input.cursor
        ? {
            created_at: asIso(input.cursor.created_at, 'cursor.created_at'),
            id: assertIdentifier(input.cursor.id, 'cursor.id'),
          }
        : null;
      if (kinds?.length === 0) return { items: [], next_cursor: null };
      const rows = await db
        .select({ interrupt: runtimeInterrupts, run: runtimeRuns })
        .from(runtimeInterrupts)
        .innerJoin(runtimeRuns, eq(runtimeInterrupts.run_id, runtimeRuns.id))
        .where(
          and(
            ...(assigneeUserId ? [eq(runtimeInterrupts.assignee_user_id, assigneeUserId)] : []),
            ...(input.status ? [eq(runtimeInterrupts.status, input.status)] : []),
            ...(kinds ? [inArray(runtimeRuns.kind, kinds)] : []),
            ...(cursor
              ? [
                  or(
                    sql`${runtimeInterrupts.created_at} < ${cursor.created_at}`,
                    and(
                      eq(runtimeInterrupts.created_at, cursor.created_at),
                      sql`${runtimeInterrupts.id} < ${cursor.id}`,
                    ),
                  ),
                ]
              : []),
          ),
        )
        .orderBy(desc(runtimeInterrupts.created_at), desc(runtimeInterrupts.id))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const tail = items.at(-1)?.interrupt;
      return {
        items,
        next_cursor: hasMore && tail ? { created_at: tail.created_at, id: tail.id } : null,
      };
    },

    async summarize(input: RuntimeSummaryInput = {}): Promise<RuntimeSummaryResult> {
      const ownerUserId = input.owner_user_id ? assertIdentifier(input.owner_user_id, 'owner_user_id') : null;
      const assigneeUserId = input.assignee_user_id
        ? assertIdentifier(input.assignee_user_id, 'assignee_user_id')
        : null;
      const kinds = input.kinds ? [...new Set(input.kinds)] : null;
      const runRows =
        kinds?.length === 0
          ? []
          : await db
              .select({
                kind: runtimeRuns.kind,
                status: runtimeRuns.status,
                count: sql<number>`count(*)`,
              })
              .from(runtimeRuns)
              .where(
                and(
                  ...(ownerUserId ? [eq(runtimeRuns.owner_user_id, ownerUserId)] : []),
                  ...(kinds ? [inArray(runtimeRuns.kind, kinds)] : []),
                ),
              )
              .groupBy(runtimeRuns.kind, runtimeRuns.status);
      const [pendingRow] =
        kinds?.length === 0
          ? [{ count: 0 }]
          : await db
              .select({ count: sql<number>`count(*)` })
              .from(runtimeInterrupts)
              .innerJoin(runtimeRuns, eq(runtimeInterrupts.run_id, runtimeRuns.id))
              .where(
                and(
                  eq(runtimeInterrupts.status, 'pending'),
                  ...(assigneeUserId ? [eq(runtimeInterrupts.assignee_user_id, assigneeUserId)] : []),
                  ...(kinds ? [inArray(runtimeRuns.kind, kinds)] : []),
                ),
              );
      const byStatus = Object.fromEntries(
        ['queued', 'claimed', 'running', 'waiting', 'paused', 'succeeded', 'failed', 'canceled', 'interrupted'].map(
          (status) => [status, 0],
        ),
      ) as Record<RuntimeRunStatus, number>;
      const byKind = Object.fromEntries(
        ['chat', 'automation', 'workflow', 'mission', 'subagent', 'eval'].map((kind) => [kind, 0]),
      ) as Record<RuntimeRunKind, number>;
      let total = 0;
      for (const row of runRows) {
        const count = Number(row.count);
        total += count;
        byStatus[row.status] += count;
        byKind[row.kind] += count;
      }
      return {
        runs: { total, by_status: byStatus, by_kind: byKind },
        pending_interrupts: Number(pendingRow?.count ?? 0),
      };
    },

    async expireInterrupts(at: string | Date = new Date(), limit = 100): Promise<RuntimeInterruptRow[]> {
      const now = asIso(at);
      const expired: RuntimeInterruptRow[] = [];
      for (let index = 0; index < Math.min(Math.max(limit, 1), 500); index += 1) {
        const row = await db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as TransactionalDb;
          const [candidate] = await tx
            .select()
            .from(runtimeInterrupts)
            .where(and(eq(runtimeInterrupts.status, 'pending'), lte(runtimeInterrupts.expires_at, now)))
            .orderBy(asc(runtimeInterrupts.expires_at), asc(runtimeInterrupts.id))
            .limit(1)
            .for('update', { skipLocked: true });
          if (!candidate) return undefined;
          const [updated] = await tx
            .update(runtimeInterrupts)
            .set({
              status: 'expired',
              updated_at: now,
              version: sql`${runtimeInterrupts.version} + 1`,
            })
            .where(
              and(
                eq(runtimeInterrupts.id, candidate.id),
                eq(runtimeInterrupts.version, candidate.version),
                eq(runtimeInterrupts.status, 'pending'),
              ),
            )
            .returning();
          if (!updated) return undefined;
          await appendEventInTransaction(
            tx,
            {
              run_id: candidate.run_id,
              step_id: candidate.step_id,
              type: 'interrupt.status_changed',
              payload: { from: 'pending', to: 'expired', result: updated! } as unknown as RuntimePayload,
              idempotency_key: `interrupt.expired:${candidate.id}:${candidate.version}`,
            },
            now,
          );
          return updated!;
        });
        if (!row) break;
        expired.push(row);
      }
      return expired;
    },

    // ─── Events / outbox ─────────────────────────────────

    async appendEvent(input: RuntimeEventAppendInput): Promise<RuntimeEventRow> {
      return db.transaction(async (tx) => appendEventInTransaction(tx as unknown as TransactionalDb, input));
    },

    async listEvents(runId: string, opts: { after?: number; limit?: number } = {}): Promise<RuntimeEventRow[]> {
      const after = assertNonnegativeInteger(opts.after ?? 0, 'after');
      const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
      return db
        .select()
        .from(runtimeEvents)
        .where(and(eq(runtimeEvents.run_id, runId), gt(runtimeEvents.seq, after)))
        .orderBy(asc(runtimeEvents.seq))
        .limit(limit);
    },

    /** Full event history for an explicitly selected Run; never auto-truncated. */
    async listAllEvents(runId: string): Promise<RuntimeEventRow[]> {
      return db
        .select()
        .from(runtimeEvents)
        .where(eq(runtimeEvents.run_id, assertIdentifier(runId, 'run_id')))
        .orderBy(asc(runtimeEvents.seq));
    },

    async getEventByIdempotency(runId: string, idempotencyKey: string): Promise<RuntimeEventRow | undefined> {
      const [row] = await db
        .select()
        .from(runtimeEvents)
        .where(
          and(
            eq(runtimeEvents.run_id, assertIdentifier(runId, 'run_id')),
            eq(runtimeEvents.idempotency_key, assertIdentifier(idempotencyKey, 'idempotency_key')),
          ),
        )
        .limit(1);
      return row;
    },

    async listOutboxForEvent(eventId: string): Promise<RuntimeOutboxRow[]> {
      return db
        .select()
        .from(runtimeOutbox)
        .where(eq(runtimeOutbox.event_id, eventId))
        .orderBy(asc(runtimeOutbox.topic));
    },

    async claimOutbox(input: RuntimeOutboxClaimInput): Promise<RuntimeOutboxRow[]> {
      const workerId = assertIdentifier(input.worker_id, 'worker_id');
      const at = asIso(input.at);
      const expiresAt = leaseExpiry(at, input.lease_ms);
      const topics = input.topics ? normalizedTopics(input.topics) : null;
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as TransactionalDb;
        await tx
          .update(runtimeOutbox)
          .set({
            status: 'dead_letter',
            lease_owner: null,
            lease_expires_at: null,
            last_error: 'delivery lease expired after final attempt',
            updated_at: at,
            version: sql`${runtimeOutbox.version} + 1`,
          })
          .where(
            and(
              eq(runtimeOutbox.status, 'claimed'),
              lte(runtimeOutbox.lease_expires_at, at),
              sql`${runtimeOutbox.attempts} >= ${runtimeOutbox.max_attempts}`,
            ),
          );
        await tx
          .update(runtimeOutbox)
          .set({
            status: 'pending',
            lease_owner: null,
            lease_expires_at: null,
            last_error: 'delivery lease expired',
            updated_at: at,
            version: sql`${runtimeOutbox.version} + 1`,
          })
          .where(
            and(
              eq(runtimeOutbox.status, 'claimed'),
              lte(runtimeOutbox.lease_expires_at, at),
              sql`${runtimeOutbox.attempts} < ${runtimeOutbox.max_attempts}`,
            ),
          );

        const candidates = await tx
          .select()
          .from(runtimeOutbox)
          .where(
            and(
              eq(runtimeOutbox.status, 'pending'),
              lte(runtimeOutbox.available_at, at),
              ...(topics ? [inArray(runtimeOutbox.topic, topics)] : []),
            ),
          )
          .orderBy(asc(runtimeOutbox.available_at), asc(runtimeOutbox.created_at), asc(runtimeOutbox.id))
          .limit(limit)
          .for('update', { skipLocked: true });
        if (candidates.length === 0) return [];
        const ids = candidates.map((row) => row.id);
        return tx
          .update(runtimeOutbox)
          .set({
            status: 'claimed',
            attempts: sql`${runtimeOutbox.attempts} + 1`,
            lease_owner: workerId,
            lease_expires_at: expiresAt,
            updated_at: at,
            version: sql`${runtimeOutbox.version} + 1`,
          })
          .where(and(inArray(runtimeOutbox.id, ids), eq(runtimeOutbox.status, 'pending')))
          .returning();
      });
    },

    async acknowledgeOutbox(input: {
      id: string;
      expected_version: number;
      worker_id: string;
      at?: string | Date;
    }): Promise<RuntimeOutboxRow> {
      const at = asIso(input.at);
      const [updated] = await db
        .update(runtimeOutbox)
        .set({
          status: 'delivered',
          lease_owner: null,
          lease_expires_at: null,
          last_error: null,
          delivered_at: at,
          updated_at: at,
          version: sql`${runtimeOutbox.version} + 1`,
        })
        .where(
          and(
            eq(runtimeOutbox.id, input.id),
            eq(runtimeOutbox.version, input.expected_version),
            eq(runtimeOutbox.status, 'claimed'),
            eq(runtimeOutbox.lease_owner, input.worker_id),
            gt(runtimeOutbox.lease_expires_at, at),
          ),
        )
        .returning();
      if (!updated) fail('runtime_lease_lost', `Runtime outbox ${input.id} lease is no longer owned by this worker`);
      return updated;
    },

    async failOutbox(input: {
      id: string;
      expected_version: number;
      worker_id: string;
      error: string;
      at?: string | Date;
    }): Promise<RuntimeOutboxRow> {
      const at = asIso(input.at);
      return db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as TransactionalDb;
        const [locked] = await tx.select().from(runtimeOutbox).where(eq(runtimeOutbox.id, input.id)).for('update');
        if (
          !locked ||
          locked.version !== input.expected_version ||
          locked.status !== 'claimed' ||
          locked.lease_owner !== input.worker_id ||
          !locked.lease_expires_at ||
          Date.parse(locked.lease_expires_at) <= Date.parse(at)
        ) {
          fail('runtime_lease_lost', `Runtime outbox ${input.id} lease is no longer owned by this worker`);
        }
        const status = locked.attempts >= locked.max_attempts ? 'dead_letter' : 'failed';
        const [updated] = await tx
          .update(runtimeOutbox)
          .set({
            status,
            lease_owner: null,
            lease_expires_at: null,
            last_error: input.error,
            updated_at: at,
            version: sql`${runtimeOutbox.version} + 1`,
          })
          .where(and(eq(runtimeOutbox.id, input.id), eq(runtimeOutbox.version, input.expected_version)))
          .returning();
        return updated!;
      });
    },

    async retryOutbox(input: {
      id: string;
      expected_version: number;
      available_at: string;
    }): Promise<RuntimeOutboxRow> {
      const at = nowIso();
      const [updated] = await db
        .update(runtimeOutbox)
        .set({
          status: 'pending',
          available_at: asIso(input.available_at, 'available_at'),
          updated_at: at,
          version: sql`${runtimeOutbox.version} + 1`,
        })
        .where(
          and(
            eq(runtimeOutbox.id, input.id),
            eq(runtimeOutbox.version, input.expected_version),
            eq(runtimeOutbox.status, 'failed'),
          ),
        )
        .returning();
      if (!updated) fail('runtime_version_conflict', `Runtime outbox ${input.id} is not retryable at this version`);
      return updated;
    },

    async listActiveRuns(limit = 200): Promise<RuntimeRunRow[]> {
      return db
        .select()
        .from(runtimeRuns)
        .where(inArray(runtimeRuns.status, [...ACTIVE_RUN_STATUSES]))
        .orderBy(asc(runtimeRuns.created_at), asc(runtimeRuns.id))
        .limit(Math.min(Math.max(limit, 1), 1000));
    },
  };
  return service;
}

export type RuntimeService = ReturnType<typeof createRuntimeService>;
