/**
 * Runtime read-model adapters for Mission and Workflow.
 *
 * Domain rows remain execution truth during convergence. These adapters only
 * mirror immutable inputs, lifecycle snapshots, steps, artifacts and human
 * interrupts into Runtime through its CAS/event APIs. They never write back
 * into a domain driver.
 */

import { createHash } from 'node:crypto';
import type {
  AgentRunApprovalRow,
  AgentRunRow,
  DatabaseProvider,
  RuntimeInterruptRow,
  RuntimeRunRow,
  RuntimeStepRow,
  WorkflowGateRow,
  WorkflowNodeRunRow,
  WorkflowRunRow,
} from '@greenhouse/db';
import {
  canTransitionRuntimeRun,
  canTransitionRuntimeStep,
  type RuntimeInterruptStatus,
  type RuntimeJsonValue,
  type RuntimeRunStatus,
  type RuntimeStepStatus,
} from '@greenhouse/types/runtime';
import { safeJsonParse } from '@greenhouse/utils/json';
import { logger } from '@greenhouse/utils/logger';
import { runtimeAdapterEnabled } from '../trusted-execution/kill-switches.js';

const RUN_STATUSES: readonly RuntimeRunStatus[] = [
  'queued',
  'claimed',
  'running',
  'waiting',
  'paused',
  'succeeded',
  'failed',
  'canceled',
  'interrupted',
];

const STEP_STATUSES: readonly RuntimeStepStatus[] = [
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
];

export interface RuntimeMirrorOptions {
  /** Suppress only a brand-new historical source's first terminal alert. */
  suppressInitialTerminalNotification?: boolean;
}

interface AdvanceRunOptions {
  suppressTerminalNotification?: boolean;
}

export function missionRuntimeRunId(sourceId: string): string {
  return `rtm_${sourceId}`;
}

export function workflowRuntimeRunId(sourceId: string): string {
  return `rtw_${sourceId}`;
}

function workflowRuntimeStepId(sourceId: number): string {
  return `rtws_${sourceId}`;
}

function missionRuntimeStepId(sourceId: string): string {
  return `rtms_${sourceId}`;
}

function jsonValue(value: unknown): RuntimeJsonValue {
  return JSON.parse(JSON.stringify(value)) as RuntimeJsonValue;
}

function parsedJson(raw: string | null, fallback: RuntimeJsonValue): RuntimeJsonValue {
  if (raw === null) return fallback;
  return safeJsonParse(raw, fallback) as RuntimeJsonValue;
}

function snapshotHash(value: RuntimeJsonValue): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isTerminalRunStatus(status: RuntimeRunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled' || status === 'interrupted';
}

async function creationSuppressesInitialTerminalNotification(db: DatabaseProvider, runId: string): Promise<boolean> {
  const event = await db.runtime.getEventByIdempotency(runId, 'run.created');
  const payload = event ? parsedJson(event.payload, null) : null;
  return (
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    payload.notification_policy === 'suppress_initial_terminal'
  );
}

function findPath<T extends string>(
  from: T,
  to: T,
  all: readonly T[],
  canTransition: (left: T, right: T) => boolean,
): T[] | null {
  if (from === to) return [];
  const queue: Array<{ status: T; path: T[] }> = [{ status: from, path: [] }];
  const visited = new Set<T>([from]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const candidate of all) {
      if (visited.has(candidate) || !canTransition(current.status, candidate)) continue;
      const path = [...current.path, candidate];
      if (candidate === to) return path;
      visited.add(candidate);
      queue.push({ status: candidate, path });
    }
  }
  return null;
}

const MISSION_RUN_STATUS: Record<AgentRunRow['status'], RuntimeRunStatus> = {
  queued: 'queued',
  starting: 'claimed',
  running: 'running',
  completed: 'succeeded',
  failed: 'failed',
  canceled: 'canceled',
};

const WORKFLOW_RUN_STATUS: Record<WorkflowRunRow['status'], RuntimeRunStatus> = {
  running: 'running',
  paused: 'paused',
  paused_for_gate: 'waiting',
  completed: 'succeeded',
  failed: 'failed',
  canceled: 'canceled',
};

const WORKFLOW_STEP_STATUS: Record<WorkflowNodeRunRow['status'], RuntimeStepStatus> = {
  pending: 'queued',
  running: 'running',
  awaiting_gate: 'waiting',
  passed: 'succeeded',
  failed: 'failed',
  skipped: 'skipped',
  returned: 'interrupted',
};

async function advanceRun(
  db: DatabaseProvider,
  run: RuntimeRunRow,
  target: RuntimeRunStatus,
  sourceSnapshot: RuntimeJsonValue,
  options: AdvanceRunOptions = {},
): Promise<RuntimeRunRow> {
  const path = findPath(run.status, target, RUN_STATUSES, canTransitionRuntimeRun);
  if (!path) {
    logger.warn('[runtime-adapter] run status cannot be reconciled through a legal path', {
      runtimeRunId: run.id,
      from: run.status,
      to: target,
    });
    return run;
  }
  let current = run;
  for (const status of path) {
    const terminal = isTerminalRunStatus(status);
    current = await db.runtime.transitionRun({
      id: current.id,
      expected_version: current.version,
      to_status: status,
      ...(status === 'running' ? { projection_only: true } : {}),
      idempotency_key: `adapter:${current.source_kind}:${current.source_id}:run:${current.version}:${status}`,
      actor_user_id: current.initiated_by_user_id,
      ...(terminal ? { output: sourceSnapshot } : {}),
      ...(terminal && options.suppressTerminalNotification ? { suppress_notification: true } : {}),
      ...(status === 'failed'
        ? {
            error_code:
              sourceSnapshot !== null && typeof sourceSnapshot === 'object' && !Array.isArray(sourceSnapshot)
                ? String(sourceSnapshot.failure_code ?? 'domain_run_failed')
                : 'domain_run_failed',
            error_message:
              sourceSnapshot !== null && typeof sourceSnapshot === 'object' && !Array.isArray(sourceSnapshot)
                ? String(sourceSnapshot.error ?? 'Domain run failed')
                : 'Domain run failed',
          }
        : {}),
    });
  }
  return current;
}

async function advanceStep(
  db: DatabaseProvider,
  step: RuntimeStepRow,
  target: RuntimeStepStatus,
  sourceSnapshot: RuntimeJsonValue,
  metrics: { tokens?: number | null; duration_ms?: number | null },
): Promise<RuntimeStepRow> {
  const path = findPath(step.status, target, STEP_STATUSES, canTransitionRuntimeStep);
  if (!path) {
    logger.warn('[runtime-adapter] step status cannot be reconciled through a legal path', {
      runtimeStepId: step.id,
      from: step.status,
      to: target,
    });
    return step;
  }
  let current = step;
  for (const status of path) {
    const terminal = ['succeeded', 'failed', 'canceled', 'interrupted', 'skipped'].includes(status);
    current = await db.runtime.transitionStep({
      id: current.id,
      expected_version: current.version,
      to_status: status,
      ...(status === 'running' ? { projection_only: true } : {}),
      idempotency_key: `adapter:step:${current.id}:${current.version}:${status}`,
      ...(terminal ? { output: sourceSnapshot } : {}),
      ...(status === 'failed'
        ? { error_code: 'domain_step_failed', error_message: 'Workflow node execution failed' }
        : {}),
      ...(metrics.tokens != null ? { tokens_used: Math.max(0, metrics.tokens) } : {}),
      ...(metrics.duration_ms != null ? { duration_ms: Math.max(0, metrics.duration_ms) } : {}),
    });
  }
  return current;
}

async function appendSnapshot(
  db: DatabaseProvider,
  runId: string,
  stepId: string | null,
  type: string,
  payload: RuntimeJsonValue,
  actorUserId: string,
): Promise<void> {
  await db.runtime.appendEvent({
    run_id: runId,
    step_id: stepId,
    type,
    payload,
    actor_user_id: actorUserId,
    idempotency_key: `adapter:snapshot:${type}:${snapshotHash(payload)}`,
  });
}

async function reconcileInterruptStatus(
  db: DatabaseProvider,
  interrupt: RuntimeInterruptRow,
  target: RuntimeInterruptStatus,
  decidedBy: string,
  decision: RuntimeJsonValue,
): Promise<void> {
  if (interrupt.status === target) return;
  if (interrupt.status !== 'pending') {
    logger.warn('[runtime-adapter] interrupt terminal status differs from domain truth', {
      interruptId: interrupt.id,
      runtimeStatus: interrupt.status,
      domainStatus: target,
    });
    return;
  }
  if (target === 'expired') {
    await db.runtime.expireInterrupts(new Date(), 500);
    return;
  }
  await db.runtime.commandInterrupt(
    {
      type: target === 'resolved' ? 'resolve' : target === 'rejected' ? 'reject' : 'cancel',
      interrupt_id: interrupt.id,
      expected_version: interrupt.version,
      idempotency_key: `adapter:interrupt:${interrupt.id}:${interrupt.version}:${target}`,
      decision,
    },
    decidedBy,
  );
}

async function mirrorMissionApproval(
  db: DatabaseProvider,
  runtimeRun: RuntimeRunRow,
  approval: AgentRunApprovalRow,
): Promise<void> {
  const id = `rtmi_${approval.id}`;
  const payload = jsonValue({
    source: 'mission_approval',
    approval_id: approval.id,
    tool_id: approval.tool_id,
    action: approval.action,
    input_hash: approval.input_hash,
    input: parsedJson(approval.input_json, { raw: approval.input_json }),
  });
  const interrupt = await db.runtime.createInterrupt({
    id,
    run_id: runtimeRun.id,
    kind: 'mutation_approval',
    payload,
    canonical_input_hash: approval.input_hash,
    risk_level: 'r1',
    assignee_user_id: approval.user_id,
    expires_at: approval.expires_at,
    actor_user_id: approval.user_id,
    idempotency_key: `adapter:mission:approval:${approval.id}`,
  });
  const target: RuntimeInterruptStatus =
    approval.status === 'pending'
      ? 'pending'
      : approval.status === 'denied'
        ? 'rejected'
        : approval.status === 'expired'
          ? 'expired'
          : 'resolved';
  if (target !== 'pending') {
    await reconcileInterruptStatus(
      db,
      interrupt,
      target,
      approval.decided_by ?? approval.user_id,
      jsonValue({ status: approval.status, decided_at: approval.decided_at, consumed_at: approval.consumed_at }),
    );
  }
}

async function mirrorWorkflowGate(
  db: DatabaseProvider,
  runtimeRun: RuntimeRunRow,
  gate: WorkflowGateRow,
): Promise<void> {
  const id = `rtwi_${gate.id}`;
  const payload = jsonValue({
    source: 'workflow_gate',
    gate_id: gate.id,
    node_id: gate.node_id,
    gate_kind: gate.kind,
    payload: parsedJson(gate.payload, { raw: gate.payload }),
  });
  const interrupt = await db.runtime.createInterrupt({
    id,
    run_id: runtimeRun.id,
    kind: 'workflow_gate',
    payload,
    risk_level: 'r1',
    assignee_user_id: runtimeRun.owner_user_id,
    actor_user_id: runtimeRun.owner_user_id,
    idempotency_key: `adapter:workflow:gate:${gate.id}`,
  });
  const target: RuntimeInterruptStatus =
    gate.status === 'pending' ? 'pending' : gate.status === 'approved' ? 'resolved' : 'rejected';
  if (target !== 'pending') {
    await reconcileInterruptStatus(
      db,
      interrupt,
      target,
      gate.decided_by ?? runtimeRun.owner_user_id,
      jsonValue({ status: gate.status, note: gate.note, decided_at: gate.decided_at }),
    );
  }
}

export async function mirrorMissionRun(
  db: DatabaseProvider,
  source: AgentRunRow,
  options: RuntimeMirrorOptions = {},
): Promise<RuntimeRunRow> {
  const sourceSnapshot = jsonValue({
    ...source,
    input_manifest: parsedJson(source.input_manifest, []),
  });
  const targetStatus = MISSION_RUN_STATUS[source.status];
  let runtimeRun = await db.runtime.createRun({
    id: missionRuntimeRunId(source.id),
    kind: 'mission',
    owner_user_id: source.user_id,
    initiated_by_user_id: source.user_id,
    session_id: source.session_id,
    source_kind: 'agent_run',
    source_id: source.id,
    idempotency_key: `mission:${source.id}`,
    max_attempts: 1,
    input: jsonValue({
      title: source.title,
      original_prompt: source.original_prompt,
      prompt: source.prompt,
      input_manifest: parsedJson(source.input_manifest, []),
      model: source.model,
      fallback_model: source.fallback_model,
      workspace_id: source.workspace_id,
      max_wall_ms: source.max_wall_ms,
      max_requests: source.max_requests,
      source_created_at: source.created_at,
    }),
    actor_user_id: source.user_id,
    ...(options.suppressInitialTerminalNotification && isTerminalRunStatus(targetStatus)
      ? { suppress_initial_terminal_notification: true }
      : {}),
  });
  const suppressTerminalNotification = await creationSuppressesInitialTerminalNotification(db, runtimeRun.id);
  runtimeRun = await advanceRun(db, runtimeRun, targetStatus, sourceSnapshot, { suppressTerminalNotification });
  await appendSnapshot(db, runtimeRun.id, null, 'mission.run.snapshot', sourceSnapshot, source.user_id);

  let missionStep = await db.runtime.createStep({
    id: missionRuntimeStepId(source.id),
    run_id: runtimeRun.id,
    step_key: 'sandbox-runner',
    kind: 'sandbox_runner_session',
    attempt: 1,
    input: jsonValue({ source_run_id: source.id, workspace_id: source.workspace_id }),
    actor_user_id: source.user_id,
  });
  missionStep = await advanceStep(
    db,
    missionStep,
    MISSION_RUN_STATUS[source.status] === 'claimed'
      ? 'claimed'
      : MISSION_RUN_STATUS[source.status] === 'succeeded'
        ? 'succeeded'
        : MISSION_RUN_STATUS[source.status],
    sourceSnapshot,
    { tokens: source.input_tokens + source.output_tokens },
  );

  let after = 0;
  for (;;) {
    const events = await db.agentRuns.listEvents(source.id, { after, limit: 1000 });
    for (const event of events) {
      await db.runtime.appendEvent({
        run_id: runtimeRun.id,
        step_id: missionStep.id,
        type: `mission.${event.type}`,
        payload: parsedJson(event.payload, { raw: event.payload }),
        actor_user_id: source.user_id,
        idempotency_key: `adapter:mission:event:${event.seq}`,
      });
      after = Math.max(after, event.seq);
    }
    if (events.length < 1000) break;
  }

  const [artifacts, approvals] = await Promise.all([
    db.agentRuns.listArtifacts(source.id),
    db.agentRuns.listApprovals(source.id, 200),
  ]);
  for (const artifact of artifacts) {
    await db.runtime.createArtifact({
      id: `rtma_${artifact.id}`,
      run_id: runtimeRun.id,
      step_id: missionStep.id,
      direction: 'output',
      kind: 'mission_artifact',
      name: artifact.path.split('/').at(-1) ?? artifact.path,
      path: artifact.path,
      content_type: artifact.content_type,
      size_bytes: artifact.size_bytes,
      sha256: artifact.sha256,
      storage_key: artifact.storage_key,
      status: 'available',
      source: 'agent_artifacts',
      actor_user_id: source.user_id,
      idempotency_key: `adapter:mission:artifact:${artifact.id}`,
    });
  }
  for (const approval of approvals) await mirrorMissionApproval(db, runtimeRun, approval);
  return runtimeRun;
}

export async function mirrorWorkflowRun(
  db: DatabaseProvider,
  source: WorkflowRunRow,
  options: RuntimeMirrorOptions = {},
): Promise<RuntimeRunRow> {
  const sourceSnapshot = jsonValue({
    ...source,
    graph: parsedJson(source.graph, {}),
    budget: parsedJson(source.budget, {}),
    summary: parsedJson(source.summary, null),
  });
  const targetStatus = WORKFLOW_RUN_STATUS[source.status];
  let runtimeRun = await db.runtime.createRun({
    id: workflowRuntimeRunId(source.id),
    kind: 'workflow',
    owner_user_id: source.user_id,
    initiated_by_user_id: source.user_id,
    source_kind: 'workflow_run',
    source_id: source.id,
    idempotency_key: `workflow:${source.id}`,
    max_attempts: 1,
    input: jsonValue({
      workflow_id: source.workflow_id,
      workflow_version: source.workflow_version,
      task_input: source.task_input,
      graph: parsedJson(source.graph, {}),
      source_created_at: source.created_at,
    }),
    actor_user_id: source.user_id,
    ...(options.suppressInitialTerminalNotification && isTerminalRunStatus(targetStatus)
      ? { suppress_initial_terminal_notification: true }
      : {}),
  });
  const suppressTerminalNotification = await creationSuppressesInitialTerminalNotification(db, runtimeRun.id);
  runtimeRun = await advanceRun(db, runtimeRun, targetStatus, sourceSnapshot, { suppressTerminalNotification });
  await appendSnapshot(db, runtimeRun.id, null, 'workflow.run.snapshot', sourceSnapshot, source.user_id);

  const [nodes, gates] = await Promise.all([db.workflows.listNodeRuns(source.id), db.workflows.listGates(source.id)]);
  for (const node of nodes) {
    const snapshot = jsonValue({
      ...node,
      inputs: parsedJson(node.inputs, {}),
      outputs: parsedJson(node.outputs, null),
      checks_result: parsedJson(node.checks_result, null),
    });
    let step = await db.runtime.createStep({
      id: workflowRuntimeStepId(node.id),
      run_id: runtimeRun.id,
      step_key: node.node_id,
      kind: 'workflow_node',
      attempt: node.attempt,
      input: jsonValue({ node_id: node.node_id, attempt: node.attempt }),
      actor_user_id: source.user_id,
    });
    step = await advanceStep(db, step, WORKFLOW_STEP_STATUS[node.status], snapshot, {
      tokens: node.tokens,
      duration_ms: node.duration_ms,
    });
    await appendSnapshot(db, runtimeRun.id, step.id, 'workflow.node.snapshot', snapshot, source.user_id);
  }
  for (const gate of gates) await mirrorWorkflowGate(db, runtimeRun, gate);
  return runtimeRun;
}

export async function mirrorMissionRunById(
  db: DatabaseProvider,
  sourceId: string,
  options: RuntimeMirrorOptions = {},
): Promise<RuntimeRunRow | null> {
  if (!runtimeAdapterEnabled('mission')) return null;
  const source = await db.agentRuns.getRunById(sourceId);
  return source ? mirrorMissionRun(db, source, options) : null;
}

export async function mirrorWorkflowRunById(
  db: DatabaseProvider,
  sourceId: string,
  options: RuntimeMirrorOptions = {},
): Promise<RuntimeRunRow | null> {
  if (!runtimeAdapterEnabled('workflow')) return null;
  const source = await db.workflows.getRun(sourceId);
  return source ? mirrorWorkflowRun(db, source, options) : null;
}

/** Read-model failures are observable but never roll back successful domain work. */
export function mirrorRuntimeRunSoon(kind: 'mission' | 'workflow', sourceId: string): void {
  if (!runtimeAdapterEnabled(kind)) return;
  void import('@greenhouse/db')
    .then(({ getDb }) =>
      kind === 'mission' ? mirrorMissionRunById(getDb(), sourceId) : mirrorWorkflowRunById(getDb(), sourceId),
    )
    .catch((error) => {
      logger.error('[runtime-adapter] immediate mirror failed; reconciler will retry', {
        kind,
        sourceId,
        error: String(error),
      });
    });
}
