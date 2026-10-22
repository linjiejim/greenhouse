/**
 * Runtime read-model adapter for Workflow.
 *
 * Domain rows remain execution truth during convergence. These adapters only
 * mirror immutable inputs, lifecycle snapshots, steps, artifacts and human
 * interrupts into Runtime through its CAS/event APIs. They never write back
 * into a domain driver.
 */

import { createHash } from 'node:crypto';
import type {
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

export function workflowRuntimeRunId(sourceId: string): string {
  return `rtw_${sourceId}`;
}

function workflowRuntimeStepId(sourceId: number): string {
  return `rtws_${sourceId}`;
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
export function mirrorRuntimeRunSoon(kind: 'workflow', sourceId: string): void {
  if (!runtimeAdapterEnabled(kind)) return;
  void import('@greenhouse/db')
    .then(({ getDb }) => mirrorWorkflowRunById(getDb(), sourceId))
    .catch((error) => {
      logger.error('[runtime-adapter] immediate mirror failed; reconciler will retry', {
        kind,
        sourceId,
        error: String(error),
      });
    });
}
