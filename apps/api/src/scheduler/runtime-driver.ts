/**
 * Durable Runtime admission and driver for user Automations.
 *
 * A cron/manual callback only persists an immutable execution snapshot. The
 * Runtime worker owns claim/lease/heartbeat and invokes the existing scheduled
 * agent executor. `max_attempts=1` is intentional: a whole agent turn may have
 * produced an external side effect before a worker disappears, so stale
 * running work is failed by Runtime and is never silently replayed.
 */

import { createHash, randomUUID } from 'node:crypto';
import { RuntimeKernelError, type DatabaseProvider, type RuntimeRunRow, type ScheduledTaskRow } from '@greenhouse/db';
import {
  RUNTIME_RUN_ACTIVE_STATUSES,
  isRuntimeRunActive,
  type RuntimePayload,
  type RuntimeRunCommandType,
  type RuntimeRunStatus,
  type RuntimeStepStatus,
} from '@greenhouse/types/runtime';
import { safeJsonParse } from '@greenhouse/utils/json';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import type { ToolRegistry } from '../agent.js';
import type { RuntimeDriver, RuntimeDriverContext } from '../runtime/worker.js';
import { settleOpenRuntimeToolCalls } from '../runtime/tool-evidence.js';
import { sanitizeForPrompt } from '../security/security.js';
import { buildTaskPrompt, buildTaskSessionTitle } from './prompt-builder.js';
import {
  executeTaskInSession,
  prepareTask,
  recordCanceledTaskSession,
  recordFailedTaskSession,
  validateTaskExecution,
} from './executor.js';

const SOURCE_PREFIX = 'scheduled_task:';
const STEP_KEY = 'agent-turn';
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_CANCEL_POLL_INTERVAL_MS = 500;

export type AutomationTrigger = 'cron' | 'manual' | 'catchup';

interface AutomationRuntimeInput {
  schema: 1;
  task: ScheduledTaskRow;
  task_id: number;
  trigger: 'scheduled' | 'manual';
  scheduled_for: string;
  session_id: string;
  prepared_prompt: string;
  session_title: string;
}

export interface EnqueueAutomationInput {
  db: DatabaseProvider;
  task: ScheduledTaskRow;
  trigger: AutomationTrigger;
  scheduledFor?: string | Date;
  initiatedByUserId?: string;
}

export interface EnqueuedAutomationRun {
  run: RuntimeRunRow;
  session_id: string;
}

export interface AutomationRuntimeDriverOptions {
  heartbeatIntervalMs?: number;
  cancelPollIntervalMs?: number;
  /** Test seam; production always uses the shared scheduled-task executor. */
  executeTask?: typeof executeTaskInSession;
}

function taskSourceKind(taskId: number): string {
  return `${SOURCE_PREFIX}${taskId}`;
}

function sourceId(trigger: AutomationTrigger, scheduledFor: string): string {
  // cron + boot catch-up are two delivery mechanisms for the SAME planned
  // occurrence. Their identity must ignore the delivery path or a crash after
  // success but before next_run_at advances would replay the side effects.
  if (trigger === 'cron' || trigger === 'catchup') return `scheduled:${scheduledFor}`;
  return `manual:${randomUUID()}`;
}

function executionTrigger(trigger: AutomationTrigger): AutomationRuntimeInput['trigger'] {
  return trigger === 'manual' ? 'manual' : 'scheduled';
}

function stableUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16]!, 16) % 4]!;
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function runtimeRunId(taskId: number, occurrenceId: string): string {
  return `rta_${createHash('sha256').update(`${taskId}:${occurrenceId}`).digest('hex').slice(0, 40)}`;
}

function taskSnapshot(task: ScheduledTaskRow): ScheduledTaskRow {
  return JSON.parse(JSON.stringify(task)) as ScheduledTaskRow;
}

function asPayload(value: unknown): RuntimePayload {
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return item.toString(10);
    if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack ?? null };
    return item;
  });
  return encoded === undefined ? null : (JSON.parse(encoded) as RuntimePayload);
}

function automationStepInput(snapshot: AutomationRuntimeInput): RuntimePayload {
  return asPayload({
    task_id: snapshot.task.id,
    session_id: snapshot.session_id,
    profile_id: snapshot.task.profile_id,
    scheduled_for: snapshot.scheduled_for,
    trigger: snapshot.trigger,
  });
}

async function ensureAutomationStep(
  db: DatabaseProvider,
  runId: string,
  snapshot: AutomationRuntimeInput,
  actorUserId: string,
): Promise<void> {
  await db.runtime.createStep({
    run_id: runId,
    step_key: STEP_KEY,
    kind: 'automation_agent_turn',
    input: automationStepInput(snapshot),
    actor_user_id: actorUserId,
  });
}

async function repairAutomationArtifacts(
  db: DatabaseProvider,
  run: RuntimeRunRow,
  snapshot: AutomationRuntimeInput,
): Promise<void> {
  await ensureAutomationStep(db, run.id, snapshot, run.initiated_by_user_id);
  await prepareTask(
    snapshot.task,
    {
      sessionId: snapshot.session_id,
      runtimeRunId: run.id,
      trigger: snapshot.trigger,
      scheduledFor: snapshot.scheduled_for,
      preparedPrompt: snapshot.prepared_prompt,
      sessionTitle: snapshot.session_title,
    },
    db,
  );
}

async function exactOccurrence(
  db: DatabaseProvider,
  input: {
    runId: string;
    taskId: number;
    source: string;
    scheduledFor: string;
    trigger: AutomationRuntimeInput['trigger'];
    sessionId: string;
  },
): Promise<EnqueuedAutomationRun | null> {
  const existing = await db.runtime.getRun(input.runId);
  if (!existing) return null;
  const snapshot = parseInput(existing);
  if (
    existing.kind !== 'automation' ||
    existing.source_kind !== taskSourceKind(input.taskId) ||
    existing.source_id !== input.source ||
    existing.session_id !== input.sessionId ||
    snapshot.task_id !== input.taskId ||
    snapshot.session_id !== input.sessionId ||
    snapshot.scheduled_for !== input.scheduledFor ||
    snapshot.trigger !== input.trigger
  ) {
    throw new RuntimeKernelError(
      'runtime_idempotency_conflict',
      `Automation occurrence ${input.runId} was reused with inconsistent identity`,
    );
  }
  // Only active admission can still be inside the Run→Step/session crash
  // window. A terminal occurrence already has its canonical visible session.
  if (['queued', 'claimed', 'running', 'waiting', 'paused'].includes(existing.status)) {
    await repairAutomationArtifacts(db, existing, snapshot);
  }
  return { run: existing, session_id: snapshot.session_id };
}

function parseInput(run: RuntimeRunRow): AutomationRuntimeInput {
  const value: unknown = safeJsonParse(run.input, null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Automation Runtime run ${run.id} has malformed input`);
  }
  const input = value as Partial<AutomationRuntimeInput>;
  if (
    input.schema !== 1 ||
    !input.task ||
    typeof input.task !== 'object' ||
    !Number.isSafeInteger(input.task_id) ||
    (input.trigger !== 'scheduled' && input.trigger !== 'manual') ||
    typeof input.scheduled_for !== 'string' ||
    !Number.isFinite(Date.parse(input.scheduled_for)) ||
    typeof input.session_id !== 'string' ||
    typeof input.prepared_prompt !== 'string' ||
    typeof input.session_title !== 'string'
  ) {
    throw new Error(`Automation Runtime run ${run.id} has malformed input`);
  }
  const task = input.task as ScheduledTaskRow;
  const expectedSource =
    input.trigger === 'scheduled'
      ? `scheduled:${input.scheduled_for}`
      : run.source_id.startsWith('manual:') && run.source_id.length > 'manual:'.length
        ? run.source_id
        : null;
  if (
    run.kind !== 'automation' ||
    task.id !== input.task_id ||
    typeof task.user_id !== 'string' ||
    typeof task.profile_id !== 'string' ||
    task.user_id !== run.owner_user_id ||
    run.source_kind !== taskSourceKind(task.id) ||
    !expectedSource ||
    run.source_id !== expectedSource ||
    run.id !== runtimeRunId(task.id, expectedSource) ||
    run.session_id !== input.session_id ||
    input.session_id !== stableUuid(`automation-session:${task.id}:${expectedSource}`)
  ) {
    throw new Error(`Automation Runtime run ${run.id} task snapshot is inconsistent`);
  }
  return input as AutomationRuntimeInput;
}

/**
 * Idempotently persist one concrete occurrence and its deterministic session.
 * Different occurrences for the same task are rejected while one is active.
 */
export async function enqueueAutomationRun(input: EnqueueAutomationInput): Promise<EnqueuedAutomationRun> {
  const scheduledFor = new Date(input.scheduledFor ?? new Date()).toISOString();
  const task = taskSnapshot(input.task);
  const source = sourceId(input.trigger, scheduledFor);
  const runId = runtimeRunId(task.id, source);
  const sessionId = stableUuid(`automation-session:${task.id}:${source}`);
  const trigger = executionTrigger(input.trigger);
  const replay = await exactOccurrence(input.db, {
    runId,
    taskId: task.id,
    source,
    scheduledFor,
    trigger,
    sessionId,
  });
  if (replay) return replay;

  await validateTaskExecution(task, input.db);
  const reference = new Date(scheduledFor);
  const snapshot: AutomationRuntimeInput = {
    schema: 1,
    task,
    task_id: task.id,
    trigger,
    scheduled_for: scheduledFor,
    session_id: sessionId,
    prepared_prompt: buildTaskPrompt(sanitizeForPrompt(task.task_prompt), task.timezone, reference),
    session_title: buildTaskSessionTitle(task.name, task.timezone, reference),
  };
  let run: RuntimeRunRow;
  try {
    const admitted = await input.db.scheduledTasks.admitRuntimeOccurrence({
      task_id: task.id,
      expected_user_id: task.user_id,
      expected_profile_id: task.profile_id,
      expected_definition: {
        name: task.name,
        task_prompt: task.task_prompt,
        schedule: task.schedule,
        timezone: task.timezone,
        enabled: task.enabled,
        max_steps: task.max_steps,
        notify_webhook: task.notify_webhook,
        notify_email: task.notify_email,
        notify_wecom: task.notify_wecom,
        notify_feishu: task.notify_feishu,
        unattended_tools: task.unattended_tools,
      },
      run: {
        id: runId,
        kind: 'automation',
        owner_user_id: task.user_id,
        initiated_by_user_id: input.initiatedByUserId ?? task.user_id,
        session_id: sessionId,
        source_kind: taskSourceKind(task.id),
        source_id: source,
        idempotency_key: `automation:${task.id}:${source}`,
        max_attempts: 1,
        single_active_source_kind: true,
        input: asPayload(snapshot),
        actor_user_id: input.initiatedByUserId ?? task.user_id,
      },
      step: {
        step_key: STEP_KEY,
        kind: 'automation_agent_turn',
        input: automationStepInput(snapshot),
        actor_user_id: input.initiatedByUserId ?? task.user_id,
      },
    });
    run = admitted.run;
  } catch (error) {
    // Two cron deliveries may race an edit of the mutable task row. The first
    // writer's persisted occurrence is canonical even if the second snapshot
    // differs; stable identity is verified before returning it.
    if (error instanceof RuntimeKernelError && error.code === 'runtime_idempotency_conflict') {
      const concurrent = await exactOccurrence(input.db, {
        runId,
        taskId: task.id,
        source,
        scheduledFor,
        trigger,
        sessionId,
      });
      if (concurrent) return concurrent;
    }
    throw error;
  }

  // Close the Run→Step/session crash window before returning. The driver and
  // exact-occurrence replay both repeat this repair idempotently.
  await repairAutomationArtifacts(input.db, run, snapshot);
  return { run, session_id: sessionId };
}

async function transitionRunTerminal(input: {
  db: DatabaseProvider;
  runId: string;
  workerId: string;
  leaseMs: number;
  attempt: number;
  status: Extract<RuntimeRunStatus, 'succeeded' | 'failed' | 'canceled'>;
  output?: RuntimePayload;
  error?: unknown;
}): Promise<void> {
  const latest = await input.db.runtime.getRun(input.runId);
  if (!latest || ['succeeded', 'failed', 'canceled', 'interrupted'].includes(latest.status)) return;
  if (latest.lease_owner !== input.workerId || (latest.status !== 'claimed' && latest.status !== 'running')) {
    throw new RuntimeKernelError('runtime_lease_lost', `Automation Runtime run ${input.runId} lease was lost`);
  }
  await input.db.runtime.transitionRun({
    id: latest.id,
    expected_version: latest.version,
    to_status: input.status,
    ...(input.status === 'canceled' ? { desired_state: 'cancel' as const } : {}),
    idempotency_key: `automation-run-${input.status}:${latest.id}:${input.attempt}`,
    worker_id: input.workerId,
    lease_ms: input.leaseMs,
    ...(input.output ? { output: input.output } : {}),
    ...(input.status === 'failed'
      ? { error_code: 'automation_driver_failed', error_message: toErrorMessage(input.error) }
      : {}),
  });
}

async function transitionStepTerminal(input: {
  db: DatabaseProvider;
  stepId: string;
  status: Extract<RuntimeStepStatus, 'succeeded' | 'failed' | 'canceled'>;
  attempt: number;
  output?: RuntimePayload;
  error?: unknown;
  durationMs?: number;
  tokensUsed?: number;
  requestsUsed?: number;
  workerId: string;
  leaseMs: number;
}): Promise<void> {
  const step = await input.db.runtime.getStep(input.stepId);
  if (!step || ['succeeded', 'failed', 'canceled', 'interrupted', 'skipped'].includes(step.status)) return;
  await input.db.runtime.transitionStep({
    id: step.id,
    expected_version: step.version,
    to_status: input.status,
    idempotency_key: `automation-step-${input.status}:${step.id}:${input.attempt}`,
    worker_id: input.workerId,
    lease_ms: input.leaseMs,
    ...(input.output ? { output: input.output } : {}),
    ...(input.status === 'failed'
      ? { error_code: 'automation_turn_failed', error_message: toErrorMessage(input.error) }
      : {}),
    ...(input.durationMs !== undefined ? { duration_ms: input.durationMs } : {}),
    ...(input.tokensUsed !== undefined ? { tokens_used: input.tokensUsed } : {}),
    ...(input.requestsUsed !== undefined ? { requests_used: input.requestsUsed } : {}),
  });
}

async function settleActiveAutomationSteps(input: {
  db: DatabaseProvider;
  runId: string;
  mode: 'failed' | 'canceled' | 'interrupted';
  error?: unknown;
  authority?: { workerId: string; leaseMs: number };
}): Promise<void> {
  for (const step of await input.db.runtime.listSteps(input.runId)) {
    if (['succeeded', 'failed', 'canceled', 'interrupted', 'skipped'].includes(step.status)) continue;
    const target =
      input.mode === 'canceled'
        ? 'canceled'
        : step.status === 'queued'
          ? 'skipped'
          : step.status === 'claimed' || step.status === 'running' || step.status === 'waiting'
            ? input.mode
            : null;
    if (!target) continue;
    try {
      await input.db.runtime.transitionStep({
        id: step.id,
        expected_version: step.version,
        to_status: target,
        idempotency_key: `automation-step-${target}:${step.id}:${step.attempt}`,
        ...(input.authority ? { worker_id: input.authority.workerId, lease_ms: input.authority.leaseMs } : {}),
        output: {
          reason:
            input.mode === 'canceled'
              ? 'runtime_cancel_requested'
              : input.mode === 'interrupted'
                ? 'runtime_lease_expired'
                : 'automation_driver_failed',
        },
        ...(input.mode === 'canceled'
          ? {}
          : {
              error_code: input.mode === 'interrupted' ? 'automation_lease_expired' : 'automation_turn_failed',
              error_message: toErrorMessage(input.error),
            }),
      });
    } catch (error) {
      if (!(error instanceof RuntimeKernelError) || error.code !== 'runtime_version_conflict') throw error;
      const latest = await input.db.runtime.getStep(step.id);
      if (!latest || !['succeeded', 'failed', 'canceled', 'interrupted', 'skipped'].includes(latest.status)) {
        throw error;
      }
    }
  }
}

interface LeaseLoop {
  stop(): Promise<void>;
  canceled(): boolean;
  signal: AbortSignal;
}

function startLeaseLoop(input: {
  context: RuntimeDriverContext;
  run: RuntimeRunRow;
  stepId: string;
  heartbeatIntervalMs: number;
  cancelPollIntervalMs: number;
}): LeaseLoop {
  const abort = new AbortController();
  let run = input.run;
  let stopped = false;
  let cancelRequested = false;
  let heartbeatBusy: Promise<void> | null = null;
  let pollBusy: Promise<void> | null = null;

  const poll = () => {
    if (stopped || pollBusy) return;
    pollBusy = input.context.db.runtime
      .getRun(run.id)
      .then((latest) => {
        if (!latest) throw new Error(`Automation Runtime run ${run.id} disappeared`);
        run = latest;
        if (latest.desired_state === 'cancel' || latest.status === 'canceled') {
          cancelRequested = true;
          abort.abort(new Error('Automation Runtime run was canceled'));
        }
      })
      .catch((error) => abort.abort(error))
      .finally(() => {
        pollBusy = null;
      });
  };

  const heartbeat = () => {
    if (stopped || abort.signal.aborted || heartbeatBusy) return;
    heartbeatBusy = (async () => {
      const latest = await input.context.db.runtime.getRun(run.id);
      if (!latest) throw new Error(`Automation Runtime run ${run.id} disappeared`);
      run = latest;
      if (run.desired_state === 'cancel') {
        cancelRequested = true;
        abort.abort(new Error('Automation Runtime run was canceled'));
        return;
      }
      run = await input.context.db.runtime.heartbeatRun({
        id: run.id,
        expected_version: run.version,
        worker_id: input.context.workerId,
        lease_ms: input.context.leaseMs,
      });
      const step = await input.context.db.runtime.getStep(input.stepId);
      if (!step) throw new Error(`Automation Runtime step ${input.stepId} disappeared`);
      await input.context.db.runtime.heartbeatStep({
        id: step.id,
        expected_version: step.version,
        worker_id: input.context.workerId,
        lease_ms: input.context.leaseMs,
      });
    })()
      .catch((error) => abort.abort(error))
      .finally(() => {
        heartbeatBusy = null;
      });
  };

  const pollTimer = setInterval(poll, Math.max(100, input.cancelPollIntervalMs));
  const heartbeatTimer = setInterval(heartbeat, Math.max(250, input.heartbeatIntervalMs));
  pollTimer.unref();
  heartbeatTimer.unref();
  return {
    signal: abort.signal,
    canceled: () => cancelRequested,
    stop: async () => {
      stopped = true;
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      await Promise.all([pollBusy, heartbeatBusy]);
    },
  };
}

export function createAutomationRuntimeDriver(
  toolRegistry: ToolRegistry,
  options: AutomationRuntimeDriverOptions = {},
): RuntimeDriver {
  const execute = options.executeTask ?? executeTaskInSession;
  return async (context) => {
    const { db, workerId } = context;
    const claimed = context.run;
    let snapshot: AutomationRuntimeInput;
    let stepId: string | null = null;
    let lease: LeaseLoop | null = null;
    try {
      if (claimed.kind !== 'automation' || !claimed.source_kind.startsWith(SOURCE_PREFIX)) {
        throw new Error('Automation Runtime driver received a non-Automation source');
      }
      snapshot = parseInput(claimed);
      const current = await db.runtime.getRun(claimed.id);
      if (!current || current.lease_owner !== workerId) {
        throw new RuntimeKernelError('runtime_lease_lost', `Automation Runtime run ${claimed.id} lease was lost`);
      }
      if (current.desired_state === 'cancel') {
        await recordCanceledTaskSession(snapshot.session_id, db);
        await settleActiveAutomationSteps({
          db,
          runId: current.id,
          mode: 'canceled',
          authority: { workerId, leaseMs: context.leaseMs },
        });
        await transitionRunTerminal({
          db,
          runId: current.id,
          workerId,
          leaseMs: context.leaseMs,
          attempt: current.attempt,
          status: 'canceled',
        });
        return;
      }

      // Revalidate owner + immutable Agent version and repair a crash after the
      // Runtime write but before the deterministic session/prompt insert.
      await validateTaskExecution(snapshot.task, db);
      // A worker can observe the queued Run after createRun commits but before
      // admission persists its Step/session. Repair both from the immutable
      // snapshot before any execution state is entered.
      await repairAutomationArtifacts(db, current, snapshot);

      const running = await db.runtime.transitionRun({
        id: current.id,
        expected_version: current.version,
        to_status: 'running',
        idempotency_key: `automation-run-running:${current.id}:${current.attempt}`,
        actor_user_id: snapshot.task.user_id,
        worker_id: workerId,
        lease_ms: context.leaseMs,
      });
      await db.scheduledTasks.updateRunStatus(snapshot.task.id, 'running');
      const step = await db.runtime.claimNextStep({
        worker_id: workerId,
        lease_ms: context.leaseMs,
        run_id: running.id,
      });
      if (!step) throw new Error(`Automation Runtime run ${running.id} has no claimable agent turn`);
      stepId = step.id;
      await db.runtime.transitionStep({
        id: step.id,
        expected_version: step.version,
        to_status: 'running',
        idempotency_key: `automation-step-running:${step.id}:${step.attempt}`,
        actor_user_id: snapshot.task.user_id,
        worker_id: workerId,
        lease_ms: context.leaseMs,
      });

      lease = startLeaseLoop({
        context,
        run: running,
        stepId: step.id,
        heartbeatIntervalMs:
          options.heartbeatIntervalMs ?? Math.min(DEFAULT_HEARTBEAT_INTERVAL_MS, Math.max(250, context.leaseMs / 3)),
        cancelPollIntervalMs: options.cancelPollIntervalMs ?? DEFAULT_CANCEL_POLL_INTERVAL_MS,
      });
      const result = await execute(snapshot.task, snapshot.session_id, toolRegistry, {
        db,
        abortSignal: lease.signal,
        runtimeRunId: running.id,
        deferLifecycle: true,
        runtimeToolEvidence: {
          runId: running.id,
          stepId: step.id,
          actorUserId: snapshot.task.user_id,
          executionAuthority: { mode: 'leased', workerId, leaseMs: context.leaseMs },
          idempotencyPrefix: `automation:${step.id}`,
        },
      });
      const executionSignal = lease.signal;
      await lease.stop();
      lease = null;

      const latest = await db.runtime.getRun(running.id);
      if (latest?.desired_state === 'cancel') {
        await recordCanceledTaskSession(snapshot.session_id, db);
        await transitionStepTerminal({
          db,
          stepId: step.id,
          status: 'canceled',
          attempt: step.attempt,
          output: { reason: 'runtime_cancel_requested' },
          workerId,
          leaseMs: context.leaseMs,
        });
        await transitionRunTerminal({
          db,
          runId: running.id,
          workerId,
          leaseMs: context.leaseMs,
          attempt: running.attempt,
          status: 'canceled',
        });
        return;
      }
      if (executionSignal.aborted) {
        throw executionSignal.reason;
      }

      const tokensUsed = (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
      await transitionStepTerminal({
        db,
        stepId: step.id,
        status: 'succeeded',
        attempt: step.attempt,
        durationMs: result.durationMs,
        tokensUsed,
        requestsUsed: 1,
        workerId,
        leaseMs: context.leaseMs,
        output: asPayload({
          session_id: snapshot.session_id,
          summary: result.text ?? '',
          tool_evidence: result.toolEvidence,
        }),
      });
      await transitionRunTerminal({
        db,
        runId: running.id,
        workerId,
        leaseMs: context.leaseMs,
        attempt: running.attempt,
        status: 'succeeded',
        output: asPayload({
          session_id: snapshot.session_id,
          summary: result.text ?? '',
          tokens_used: tokensUsed,
          tool_evidence: result.toolEvidence,
        }),
      });
    } catch (error) {
      await lease?.stop();
      let parsed: AutomationRuntimeInput | null = null;
      try {
        parsed = parseInput(claimed);
      } catch {
        // The malformed input is itself the terminal error.
      }
      const latest = await db.runtime.getRun(claimed.id);
      const canceled = latest?.desired_state === 'cancel' || lease?.canceled() === true;
      const liveLeaseExpiresAt = latest?.lease_expires_at ? Date.parse(latest.lease_expires_at) : Number.NaN;
      const lostAuthority =
        !latest ||
        latest.lease_owner !== workerId ||
        (latest.status !== 'claimed' && latest.status !== 'running') ||
        !Number.isFinite(liveLeaseExpiresAt) ||
        liveLeaseExpiresAt <= Date.now();
      const heartbeatRejected = error instanceof RuntimeKernelError && error.code === 'runtime_lease_lost';
      const leaseLost = lostAuthority || (heartbeatRejected && latest?.desired_state !== 'cancel');
      // A stale claimant has no authority to mutate the task/session domain.
      // A fresh worker may already own and execute the same Run. The one
      // exception is a durable cancel intent on the still-owned wind-down
      // lease, which this worker must project to every source-domain fact.
      if (leaseLost && !canceled) throw error;
      if (parsed) {
        if (canceled) await recordCanceledTaskSession(parsed.session_id, db);
        else await recordFailedTaskSession(parsed.session_id, toErrorMessage(error), false, db);
      }
      if (!leaseLost || canceled) {
        try {
          await settleActiveAutomationSteps({
            db,
            runId: claimed.id,
            mode: canceled ? 'canceled' : 'failed',
            ...(canceled ? {} : { error }),
            authority: { workerId, leaseMs: context.leaseMs },
          });
        } catch (stepError) {
          logger.warn('[automation-runtime] could not settle active steps', {
            runId: claimed.id,
            stepId,
            error: toErrorMessage(stepError),
          });
        }
      }
      // A cancel can win between claiming the Step and entering `running`.
      // The Step transition then correctly reports a lost parent lease because
      // the Run's desired_state is already `cancel`. Treat that as the durable
      // cancellation boundary, not as an unhandled worker failure.
      await transitionRunTerminal({
        db,
        runId: claimed.id,
        workerId,
        leaseMs: context.leaseMs,
        attempt: claimed.attempt,
        status: canceled ? 'canceled' : 'failed',
        ...(canceled ? {} : { error }),
      });
    }
  };
}

/** Project a queued/stale Runtime cancellation after its terminal CAS commits. */
export async function reconcileCanceledAutomationRun(db: DatabaseProvider, run: RuntimeRunRow): Promise<void> {
  if (run.kind !== 'automation' || !run.source_kind.startsWith(SOURCE_PREFIX) || run.status !== 'canceled') return;
  const input = parseInput(run);
  await settleActiveAutomationSteps({ db, runId: run.id, mode: 'canceled' });
  await recordCanceledTaskSession(input.session_id, db);
}

/** Validate Automation's only Runtime-native command while the command fence is held. */
export async function delegateAutomationRuntimeCancel(
  db: DatabaseProvider,
  run: RuntimeRunRow,
  command: RuntimeRunCommandType,
  mayDrive: boolean,
): Promise<void> {
  if (run.kind !== 'automation' || !run.source_kind.startsWith(SOURCE_PREFIX) || command !== 'cancel') {
    throw new RuntimeKernelError('runtime_invalid_transition', `Automation does not support ${command}`);
  }
  const input = parseInput(run);
  const task = await db.scheduledTasks.getById(input.task_id);
  const session = await db.sessions.getById(input.session_id);
  if (
    (task && task.user_id !== run.owner_user_id) ||
    (session &&
      (session.user_id !== run.owner_user_id ||
        session.profile_id !== input.task.profile_id ||
        session.channel !== 'task'))
  ) {
    throw new RuntimeKernelError('runtime_not_found', 'Automation source task or session is missing');
  }
  if (!mayDrive && run.desired_state !== 'cancel') {
    throw new RuntimeKernelError('runtime_version_conflict', `Runtime run ${run.id} changed concurrently`);
  }
}

/** Finalize queued cancel immediately; claimed/running drivers poll durable intent. */
export async function settleQueuedAutomationCancellation(
  db: DatabaseProvider,
  run: RuntimeRunRow,
  actorUserId: string,
): Promise<RuntimeRunRow> {
  if (run.kind !== 'automation' || !run.source_kind.startsWith(SOURCE_PREFIX)) return run;
  if (run.status === 'canceled') {
    await reconcileCanceledAutomationRun(db, run);
    return run;
  }
  if (run.status !== 'queued' || run.desired_state !== 'cancel') return run;
  await settleActiveAutomationSteps({ db, runId: run.id, mode: 'canceled' });
  const latest = await db.runtime.getRun(run.id);
  if (!latest) return run;
  if (latest.status === 'canceled') {
    await reconcileCanceledAutomationRun(db, latest);
    return latest;
  }
  if (latest.status !== 'queued' || latest.desired_state !== 'cancel') return latest;
  const canceled = await db.runtime.transitionRun({
    id: latest.id,
    expected_version: latest.version,
    to_status: 'canceled',
    desired_state: 'cancel',
    idempotency_key: `automation-queued-cancel:${latest.id}`,
    actor_user_id: actorUserId,
    output: {
      session_id: latest.session_id,
      reason: 'runtime_cancel_requested_before_claim',
      requested_by_user_id: actorUserId,
    },
    error_code: 'automation_canceled',
    error_message: 'Automation canceled before execution was claimed',
    settled_at: new Date().toISOString(),
  });
  await reconcileCanceledAutomationRun(db, canceled);
  return canceled;
}

/** Request cancellation through Runtime's durable command fence. */
export async function requestAutomationRuntimeCancellation(
  db: DatabaseProvider,
  runId: string,
  actorUserId: string,
  idempotencyKey: string,
): Promise<RuntimeRunRow> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const run = await db.runtime.getRun(runId);
    if (!run) throw new RuntimeKernelError('runtime_not_found', 'Automation Runtime run is missing');
    if (!isRuntimeRunActive(run.status)) return run;
    if (run.desired_state === 'cancel') return settleQueuedAutomationCancellation(db, run, actorUserId);
    try {
      const fenced = await db.runtime.executeRunDomainCommand(
        {
          type: 'cancel',
          run_id: run.id,
          expected_version: run.version,
          idempotency_key: idempotencyKey,
        },
        actorUserId,
        ({ run: locked, may_drive: mayDrive }) => delegateAutomationRuntimeCancel(db, locked, 'cancel', mayDrive),
      );
      return settleQueuedAutomationCancellation(db, fenced.run, actorUserId);
    } catch (error) {
      if (!(error instanceof RuntimeKernelError) || error.code !== 'runtime_version_conflict' || attempt === 3) {
        throw error;
      }
    }
  }
  throw new RuntimeKernelError('runtime_version_conflict', `Runtime run ${runId} changed concurrently`);
}

/** Cancel every queued/in-flight Automation owned by an account under security suspension. */
export async function cancelAutomationRunsForUser(
  db: DatabaseProvider,
  userId: string,
  actorUserId = userId,
): Promise<number> {
  let cursor: { created_at: string; id: string } | undefined;
  let canceled = 0;
  do {
    const page = await db.runtime.listRuns({
      owner_user_id: userId,
      kinds: ['automation'],
      statuses: RUNTIME_RUN_ACTIVE_STATUSES,
      ...(cursor ? { cursor } : {}),
      limit: 100,
    });
    for (const run of page.items) {
      await requestAutomationRuntimeCancellation(
        db,
        run.id,
        actorUserId,
        `account-security:automation-cancel:${run.id}`,
      );
      canceled += 1;
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return canceled;
}

/** Sync the scheduled-task/session/Step projection after generic stale reclaim. */
export async function reconcileReclaimedAutomationRun(db: DatabaseProvider, run: RuntimeRunRow): Promise<void> {
  if (run.kind !== 'automation' || !run.source_kind.startsWith(SOURCE_PREFIX)) return;
  try {
    if (run.status === 'canceled') {
      await settleOpenRuntimeToolCalls(db, run.id, 'canceled', run.owner_user_id);
      await reconcileCanceledAutomationRun(db, run);
    } else if (run.status === 'failed') {
      await settleOpenRuntimeToolCalls(db, run.id, 'uncertain', run.owner_user_id);
      const input = parseInput(run);
      const message = run.error_message ?? 'Automation worker stopped before the run could be safely completed';
      await settleActiveAutomationSteps({ db, runId: run.id, mode: 'interrupted', error: message });
      await recordFailedTaskSession(input.session_id, message, false, db);
    }
  } catch (error) {
    logger.error('[automation-runtime] could not reconcile a stale run', {
      runId: run.id,
      error: toErrorMessage(error),
    });
    throw error;
  }
}
