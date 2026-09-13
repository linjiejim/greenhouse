/**
 * Shared Runtime control-plane contract.
 *
 * Runtime is deliberately an execution envelope, not a universal workflow
 * engine. Mission workspace/container state, Workflow DAG state, Chat stream
 * replay and Eval scoring remain in their domain contracts. Adapters connect
 * those facts to this common lifecycle, interrupt and observability surface.
 *
 * Design spec: docs/specs/20260812-trusted-execution-platform-convergence.md
 */

// ─── JSON payloads ──────────────────────────────────────

export type RuntimeJsonPrimitive = string | number | boolean | null;

export type RuntimeJsonValue = RuntimeJsonPrimitive | RuntimeJsonValue[] | { [key: string]: RuntimeJsonValue };

/**
 * Exact persisted payload.
 *
 * Producers, adapters and persistence layers MUST preserve this whole value:
 * no automatic truncation, excerpting or expiry. Large binary objects belong
 * in object storage, with provenance and a hash in RuntimeArtifact.
 */
export type RuntimePayload = RuntimeJsonValue;

// ─── Run ────────────────────────────────────────────────

export type RuntimeRunKind = 'chat' | 'automation' | 'workflow' | 'mission' | 'subagent' | 'eval';

export const RUNTIME_RUN_KINDS = [
  'chat',
  'automation',
  'workflow',
  'mission',
  'subagent',
  'eval',
] as const satisfies readonly RuntimeRunKind[];

export type RuntimeRunStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'interrupted';

export type RuntimeDesiredState = 'run' | 'pause' | 'cancel';

export const RUNTIME_RUN_STATUSES = [
  'queued',
  'claimed',
  'running',
  'waiting',
  'paused',
  'succeeded',
  'failed',
  'canceled',
  'interrupted',
] as const satisfies readonly RuntimeRunStatus[];

export const RUNTIME_DESIRED_STATES = ['run', 'pause', 'cancel'] as const satisfies readonly RuntimeDesiredState[];

export const RUNTIME_RUN_ACTIVE_STATUSES = [
  'queued',
  'claimed',
  'running',
  'waiting',
  'paused',
] as const satisfies readonly RuntimeRunStatus[];

export const RUNTIME_RUN_TERMINAL_STATUSES = [
  'succeeded',
  'failed',
  'canceled',
  'interrupted',
] as const satisfies readonly RuntimeRunStatus[];

const RUNTIME_RUN_TRANSITIONS = {
  queued: ['claimed', 'canceled'],
  claimed: ['queued', 'running', 'failed', 'canceled', 'interrupted'],
  running: ['waiting', 'paused', 'succeeded', 'failed', 'canceled', 'interrupted'],
  waiting: ['running', 'paused', 'failed', 'canceled', 'interrupted'],
  paused: ['queued', 'running', 'canceled'],
  succeeded: [],
  failed: ['queued'],
  canceled: [],
  interrupted: ['queued'],
} as const satisfies Record<RuntimeRunStatus, readonly RuntimeRunStatus[]>;

export function isRuntimeRunActive(status: RuntimeRunStatus): boolean {
  return (RUNTIME_RUN_ACTIVE_STATUSES as readonly RuntimeRunStatus[]).includes(status);
}

export function isRuntimeRunTerminal(status: RuntimeRunStatus): boolean {
  return (RUNTIME_RUN_TERMINAL_STATUSES as readonly RuntimeRunStatus[]).includes(status);
}

/** State transition legality only; callers still need CAS and authorization. */
export function canTransitionRuntimeRun(from: RuntimeRunStatus, to: RuntimeRunStatus): boolean {
  return (RUNTIME_RUN_TRANSITIONS[from] as readonly RuntimeRunStatus[]).includes(to);
}

export interface RuntimeRun<
  TInput extends RuntimePayload = RuntimePayload,
  TOutput extends RuntimePayload = RuntimePayload,
> {
  id: string;
  kind: RuntimeRunKind;
  owner_user_id: string;
  initiated_by_user_id: string;
  session_id: string | null;
  parent_run_id: string | null;
  root_run_id: string;
  source_kind: string;
  source_id: string;
  idempotency_key: string | null;
  status: RuntimeRunStatus;
  desired_state: RuntimeDesiredState;
  wait_reason: string | null;
  priority: number;
  not_before: string | null;
  deadline_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  attempt: number;
  max_attempts: number;
  input: TInput;
  output: TOutput | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  ended_at: string | null;
  settled_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

// ─── Step ───────────────────────────────────────────────

export type RuntimeStepStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'interrupted'
  | 'skipped';

export const RUNTIME_STEP_STATUSES = [
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
] as const satisfies readonly RuntimeStepStatus[];

export const RUNTIME_STEP_TERMINAL_STATUSES = [
  'succeeded',
  'failed',
  'canceled',
  'interrupted',
  'skipped',
] as const satisfies readonly RuntimeStepStatus[];

const RUNTIME_STEP_TRANSITIONS = {
  queued: ['claimed', 'canceled', 'skipped'],
  claimed: ['queued', 'running', 'failed', 'canceled', 'interrupted'],
  running: ['waiting', 'paused', 'succeeded', 'failed', 'canceled', 'interrupted'],
  waiting: ['running', 'paused', 'failed', 'canceled', 'interrupted'],
  paused: ['queued', 'running', 'canceled'],
  succeeded: [],
  failed: ['queued'],
  canceled: [],
  interrupted: ['queued'],
  skipped: [],
} as const satisfies Record<RuntimeStepStatus, readonly RuntimeStepStatus[]>;

export function isRuntimeStepTerminal(status: RuntimeStepStatus): boolean {
  return (RUNTIME_STEP_TERMINAL_STATUSES as readonly RuntimeStepStatus[]).includes(status);
}

/** State transition legality only; callers still need CAS and lease ownership. */
export function canTransitionRuntimeStep(from: RuntimeStepStatus, to: RuntimeStepStatus): boolean {
  return (RUNTIME_STEP_TRANSITIONS[from] as readonly RuntimeStepStatus[]).includes(to);
}

export interface RuntimeStep<
  TInput extends RuntimePayload = RuntimePayload,
  TOutput extends RuntimePayload = RuntimePayload,
> {
  id: string;
  run_id: string;
  parent_step_id: string | null;
  step_key: string;
  kind: string;
  attempt: number;
  status: RuntimeStepStatus;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  input: TInput;
  output: TOutput | null;
  error_code: string | null;
  error_message: string | null;
  tokens_used: number;
  requests_used: number;
  cost_micros: number;
  duration_ms: number | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

// ─── Tool call ──────────────────────────────────────────

export type RuntimeActionRisk = 'r0' | 'r1' | 'r2' | 'r3';

export const RUNTIME_ACTION_RISKS = ['r0', 'r1', 'r2', 'r3'] as const satisfies readonly RuntimeActionRisk[];

export type RuntimeToolCallStatus =
  | 'pending'
  | 'awaiting_approval'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'uncertain';

export const RUNTIME_TOOL_CALL_STATUSES = [
  'pending',
  'awaiting_approval',
  'running',
  'succeeded',
  'failed',
  'canceled',
  'uncertain',
] as const satisfies readonly RuntimeToolCallStatus[];

export const RUNTIME_TOOL_CALL_TERMINAL_STATUSES = [
  'succeeded',
  'failed',
  'canceled',
] as const satisfies readonly RuntimeToolCallStatus[];

const RUNTIME_TOOL_CALL_TRANSITIONS = {
  pending: ['awaiting_approval', 'running', 'canceled'],
  awaiting_approval: ['running', 'canceled'],
  running: ['succeeded', 'failed', 'canceled', 'uncertain'],
  succeeded: [],
  failed: [],
  canceled: [],
  // A human reconciliation may establish the actual external outcome.
  uncertain: ['succeeded', 'failed', 'canceled'],
} as const satisfies Record<RuntimeToolCallStatus, readonly RuntimeToolCallStatus[]>;

export function isRuntimeToolCallTerminal(status: RuntimeToolCallStatus): boolean {
  return (RUNTIME_TOOL_CALL_TERMINAL_STATUSES as readonly RuntimeToolCallStatus[]).includes(status);
}

export function canTransitionRuntimeToolCall(from: RuntimeToolCallStatus, to: RuntimeToolCallStatus): boolean {
  return (RUNTIME_TOOL_CALL_TRANSITIONS[from] as readonly RuntimeToolCallStatus[]).includes(to);
}

export interface RuntimeToolCall<
  TInput extends RuntimePayload = RuntimePayload,
  TOutput extends RuntimePayload = RuntimePayload,
> {
  id: string;
  run_id: string;
  step_id: string | null;
  tool_name: string;
  status: RuntimeToolCallStatus;
  input: TInput;
  output: TOutput | null;
  canonical_input_hash: string;
  risk_level: RuntimeActionRisk;
  idempotency_key: string | null;
  interrupt_id: string | null;
  platform_audit_event_id: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

// ─── Artifact ───────────────────────────────────────────

export type RuntimeArtifactDirection = 'input' | 'output';
export type RuntimeArtifactStatus = 'pending' | 'available' | 'failed' | 'skipped';

export const RUNTIME_ARTIFACT_DIRECTIONS = ['input', 'output'] as const satisfies readonly RuntimeArtifactDirection[];

export const RUNTIME_ARTIFACT_STATUSES = [
  'pending',
  'available',
  'failed',
  'skipped',
] as const satisfies readonly RuntimeArtifactStatus[];

const RUNTIME_ARTIFACT_TRANSITIONS = {
  pending: ['available', 'failed', 'skipped'],
  available: [],
  failed: [],
  skipped: [],
} as const satisfies Record<RuntimeArtifactStatus, readonly RuntimeArtifactStatus[]>;

export function canTransitionRuntimeArtifact(from: RuntimeArtifactStatus, to: RuntimeArtifactStatus): boolean {
  return (RUNTIME_ARTIFACT_TRANSITIONS[from] as readonly RuntimeArtifactStatus[]).includes(to);
}

export interface RuntimeArtifact {
  id: string;
  run_id: string;
  step_id: string | null;
  tool_call_id: string | null;
  direction: RuntimeArtifactDirection;
  kind: string;
  name: string;
  path: string | null;
  content_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  storage_key: string | null;
  status: RuntimeArtifactStatus;
  source: string;
  created_at: string;
  updated_at: string;
}

// ─── Interrupt ──────────────────────────────────────────

export type RuntimeInterruptKind =
  | 'mutation_approval'
  | 'workflow_gate'
  | 'ask_user'
  | 'credential_required'
  | 'budget_exceeded'
  | 'external_dependency'
  | 'outcome_unknown'
  | 'manual_pause';

export type RuntimeInterruptStatus = 'pending' | 'resolved' | 'rejected' | 'expired' | 'canceled';

export const RUNTIME_INTERRUPT_KINDS = [
  'mutation_approval',
  'workflow_gate',
  'ask_user',
  'credential_required',
  'budget_exceeded',
  'external_dependency',
  'outcome_unknown',
  'manual_pause',
] as const satisfies readonly RuntimeInterruptKind[];

export const RUNTIME_INTERRUPT_STATUSES = [
  'pending',
  'resolved',
  'rejected',
  'expired',
  'canceled',
] as const satisfies readonly RuntimeInterruptStatus[];

export const RUNTIME_INTERRUPT_TERMINAL_STATUSES = [
  'resolved',
  'rejected',
  'expired',
  'canceled',
] as const satisfies readonly RuntimeInterruptStatus[];

const RUNTIME_INTERRUPT_TRANSITIONS = {
  pending: ['resolved', 'rejected', 'expired', 'canceled'],
  resolved: [],
  rejected: [],
  expired: [],
  canceled: [],
} as const satisfies Record<RuntimeInterruptStatus, readonly RuntimeInterruptStatus[]>;

export function isRuntimeInterruptTerminal(status: RuntimeInterruptStatus): boolean {
  return (RUNTIME_INTERRUPT_TERMINAL_STATUSES as readonly RuntimeInterruptStatus[]).includes(status);
}

export function canTransitionRuntimeInterrupt(from: RuntimeInterruptStatus, to: RuntimeInterruptStatus): boolean {
  return (RUNTIME_INTERRUPT_TRANSITIONS[from] as readonly RuntimeInterruptStatus[]).includes(to);
}

export interface RuntimeInterrupt<
  TPayload extends RuntimePayload = RuntimePayload,
  TDecision extends RuntimePayload = RuntimePayload,
> {
  id: string;
  run_id: string;
  step_id: string | null;
  tool_call_id: string | null;
  kind: RuntimeInterruptKind;
  status: RuntimeInterruptStatus;
  payload: TPayload;
  canonical_input_hash: string | null;
  risk_level: RuntimeActionRisk | null;
  assignee_user_id: string;
  expires_at: string | null;
  decision: TDecision | null;
  decided_by_user_id: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

// ─── Event and outbox ───────────────────────────────────

export type RuntimeEventType =
  | 'run.created'
  | 'run.status_changed'
  | 'run.heartbeat'
  | 'step.created'
  | 'step.status_changed'
  | 'step.heartbeat'
  | 'tool.requested'
  | 'tool.status_changed'
  | 'artifact.created'
  | 'artifact.status_changed'
  | 'interrupt.created'
  | 'interrupt.status_changed'
  | 'budget.reserved'
  | 'budget.settled'
  | 'budget.released';

export const RUNTIME_EVENT_TYPES = [
  'run.created',
  'run.status_changed',
  'run.heartbeat',
  'step.created',
  'step.status_changed',
  'step.heartbeat',
  'tool.requested',
  'tool.status_changed',
  'artifact.created',
  'artifact.status_changed',
  'interrupt.created',
  'interrupt.status_changed',
  'budget.reserved',
  'budget.settled',
  'budget.released',
] as const satisfies readonly RuntimeEventType[];

/**
 * Append-only recorded fact. RuntimeEvent intentionally has no mutable status;
 * delivery lifecycle belongs to RuntimeOutbox.
 */
export interface RuntimeEvent<TPayload extends RuntimePayload = RuntimePayload> {
  id: string;
  run_id: string;
  step_id: string | null;
  seq: number;
  type: RuntimeEventType | (string & {});
  payload: TPayload;
  actor_user_id: string | null;
  idempotency_key: string | null;
  created_at: string;
}

export type RuntimeOutboxStatus = 'pending' | 'claimed' | 'delivered' | 'failed' | 'dead_letter';

export const RUNTIME_OUTBOX_STATUSES = [
  'pending',
  'claimed',
  'delivered',
  'failed',
  'dead_letter',
] as const satisfies readonly RuntimeOutboxStatus[];

const RUNTIME_OUTBOX_TRANSITIONS = {
  pending: ['claimed'],
  claimed: ['pending', 'delivered', 'failed'],
  delivered: [],
  failed: ['pending', 'dead_letter'],
  dead_letter: [],
} as const satisfies Record<RuntimeOutboxStatus, readonly RuntimeOutboxStatus[]>;

export function canTransitionRuntimeOutbox(from: RuntimeOutboxStatus, to: RuntimeOutboxStatus): boolean {
  return (RUNTIME_OUTBOX_TRANSITIONS[from] as readonly RuntimeOutboxStatus[]).includes(to);
}

export interface RuntimeOutbox<TPayload extends RuntimePayload = RuntimePayload> {
  id: string;
  event_id: string;
  topic: string;
  payload: TPayload;
  status: RuntimeOutboxStatus;
  attempts: number;
  max_attempts: number;
  available_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

// ─── Commands ───────────────────────────────────────────

export type RuntimeRunCommandType = 'start' | 'pause' | 'resume' | 'cancel' | 'retry';

export const RUNTIME_RUN_COMMAND_TYPES = [
  'start',
  'pause',
  'resume',
  'cancel',
  'retry',
] as const satisfies readonly RuntimeRunCommandType[];

export interface RuntimeRunCommand {
  type: RuntimeRunCommandType;
  run_id: string;
  expected_version: number;
  idempotency_key: string;
}

export type RuntimeInterruptCommandType = 'resolve' | 'reject' | 'cancel';

export const RUNTIME_INTERRUPT_COMMAND_TYPES = [
  'resolve',
  'reject',
  'cancel',
] as const satisfies readonly RuntimeInterruptCommandType[];

export interface RuntimeInterruptCommand<TDecision extends RuntimePayload = RuntimePayload> {
  type: RuntimeInterruptCommandType;
  interrupt_id: string;
  expected_version: number;
  idempotency_key: string;
  decision: TDecision | null;
}

export function isRuntimeRunCommandLegal(
  status: RuntimeRunStatus,
  command: RuntimeRunCommandType,
  desiredState: RuntimeDesiredState = 'run',
): boolean {
  if (command === 'start') return status === 'queued' && desiredState === 'run';
  if (command === 'pause') return status === 'running' && desiredState === 'run';
  if (command === 'resume') return status === 'paused' && desiredState !== 'cancel';
  if (command === 'cancel') return isRuntimeRunActive(status) && desiredState !== 'cancel';
  return status === 'failed' || status === 'interrupted';
}

export function isRuntimeInterruptCommandLegal(
  status: RuntimeInterruptStatus,
  command: RuntimeInterruptCommandType,
): boolean {
  if (status !== 'pending') return false;
  return command === 'resolve' || command === 'reject' || command === 'cancel';
}

// ─── User projection and action capabilities ────────────

export type RuntimeLifecycle = 'queued' | 'preparing' | 'running' | 'paused' | 'completed' | 'failed' | 'canceled';

export type RuntimeAttention = 'none' | 'approval' | 'input' | 'review';
export type RuntimeTransport = 'live' | 'reconnecting' | 'stale' | 'offline';

export const RUNTIME_LIFECYCLES = [
  'queued',
  'preparing',
  'running',
  'paused',
  'completed',
  'failed',
  'canceled',
] as const satisfies readonly RuntimeLifecycle[];

export const RUNTIME_ATTENTION_STATES = [
  'none',
  'approval',
  'input',
  'review',
] as const satisfies readonly RuntimeAttention[];

export const RUNTIME_TRANSPORT_STATES = [
  'live',
  'reconnecting',
  'stale',
  'offline',
] as const satisfies readonly RuntimeTransport[];

export interface RuntimeUserProjection {
  lifecycle: RuntimeLifecycle;
  attention: RuntimeAttention;
  transport: RuntimeTransport;
}

export type RuntimeUserAction = RuntimeRunCommandType | 'approve' | 'reject' | 'provide_input' | 'review';

export interface RuntimePendingInterrupt {
  kind: RuntimeInterruptKind;
  status: RuntimeInterruptStatus;
}

const RUNTIME_STATUS_LIFECYCLE = {
  queued: 'queued',
  claimed: 'preparing',
  running: 'running',
  waiting: 'paused',
  paused: 'paused',
  succeeded: 'completed',
  failed: 'failed',
  canceled: 'canceled',
  interrupted: 'failed',
} as const satisfies Record<RuntimeRunStatus, RuntimeLifecycle>;

const RUNTIME_INTERRUPT_ATTENTION = {
  mutation_approval: 'approval',
  workflow_gate: 'approval',
  ask_user: 'input',
  credential_required: 'input',
  budget_exceeded: 'input',
  external_dependency: 'input',
  outcome_unknown: 'review',
  manual_pause: 'review',
} as const satisfies Record<RuntimeInterruptKind, Exclude<RuntimeAttention, 'none'>>;

const RUNTIME_ATTENTION_PRIORITY = {
  none: 0,
  review: 1,
  input: 2,
  approval: 3,
} as const satisfies Record<RuntimeAttention, number>;

export function projectRuntimeLifecycle(status: RuntimeRunStatus): RuntimeLifecycle {
  return RUNTIME_STATUS_LIFECYCLE[status];
}

export function projectRuntimeAttention(interrupts: readonly RuntimePendingInterrupt[]): RuntimeAttention {
  let attention: RuntimeAttention = 'none';
  for (const interrupt of interrupts) {
    if (interrupt.status !== 'pending') continue;
    const candidate = RUNTIME_INTERRUPT_ATTENTION[interrupt.kind];
    if (RUNTIME_ATTENTION_PRIORITY[candidate] > RUNTIME_ATTENTION_PRIORITY[attention]) {
      attention = candidate;
    }
  }
  return attention;
}

export function projectRuntimeForUser(input: {
  status: RuntimeRunStatus;
  interrupts?: readonly RuntimePendingInterrupt[];
  transport?: RuntimeTransport;
}): RuntimeUserProjection {
  return {
    lifecycle: projectRuntimeLifecycle(input.status),
    attention: projectRuntimeAttention(input.interrupts ?? []),
    transport: input.transport ?? 'live',
  };
}

function actionsForPendingInterrupt(kind: RuntimeInterruptKind): readonly RuntimeUserAction[] {
  if (kind === 'mutation_approval' || kind === 'workflow_gate') return ['approve', 'reject'];
  if (
    kind === 'ask_user' ||
    kind === 'credential_required' ||
    kind === 'budget_exceeded' ||
    kind === 'external_dependency'
  ) {
    return ['provide_input'];
  }
  return ['review'];
}

/**
 * Legal actions intersected with a driver's declared capabilities. Passing no
 * capability produces no button; a source that cannot pause/retry must never
 * acquire those actions merely because another driver supports them.
 */
export function availableRuntimeUserActions(input: {
  status: RuntimeRunStatus;
  desired_state?: RuntimeDesiredState;
  interrupts?: readonly RuntimePendingInterrupt[];
  supported_actions: readonly RuntimeUserAction[];
}): RuntimeUserAction[] {
  const candidates = new Set<RuntimeUserAction>();
  const runCommands: readonly RuntimeRunCommandType[] = ['start', 'pause', 'resume', 'cancel', 'retry'];

  for (const command of runCommands) {
    if (isRuntimeRunCommandLegal(input.status, command, input.desired_state)) candidates.add(command);
  }
  for (const interrupt of input.interrupts ?? []) {
    if (interrupt.status !== 'pending') continue;
    for (const action of actionsForPendingInterrupt(interrupt.kind)) candidates.add(action);
  }

  return input.supported_actions.filter(
    (action, index, all) => candidates.has(action) && all.indexOf(action) === index,
  );
}
