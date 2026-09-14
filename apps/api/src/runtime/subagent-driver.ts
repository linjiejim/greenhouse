/**
 * Durable Runtime driver for `spawn_session` child turns.
 *
 * The child session remains the transcript/domain fact. Runtime owns durable
 * admission, lineage, lease, cancellation intent and the permanent exact
 * execution payload. A queued child may be claimed after process restart; a
 * claimed/running child has max_attempts=1 and is never replayed after a stale
 * lease because one agent turn may already have performed external writes.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseProvider, RuntimeRunRow, RuntimeStepRow } from '@greenhouse/db';
import { RuntimeKernelError } from '@greenhouse/db';
import type {
  RuntimePayload,
  RuntimeRunCommandType,
  RuntimeRunStatus,
  RuntimeStepStatus,
} from '@greenhouse/types/runtime';
import type { UserRole } from '../auth/token.js';
import type { ToolRegistry } from '../agent.js';
import {
  runAgentInSession,
  SessionTranscriptChangedError,
  type AgentGenerate,
  type RunAgentResult,
} from '../agent-runtime/run-agent.js';
import { resolveMemoryContext } from '../llm/memory.js';
import {
  enrichSystemPrompt,
  assertPinnedProfileExecutionAccess,
  normalizeProfileId,
  resolveProfileAsync,
  type AgentProfile,
} from '../profiles/profile.js';
import { toErrorMessage } from '@greenhouse/utils/error';
import { safeJsonParse } from '@greenhouse/utils/json';
import { logger } from '@greenhouse/utils/logger';
import type { RuntimeDriver, RuntimeDriverContext } from './worker.js';
import { settleOpenRuntimeToolCalls } from './tool-evidence.js';

export const SUBAGENT_SOURCE_KIND = 'spawned_session';
export const SUBAGENT_STEP_KEY = 'agent-turn';
export const SUBAGENT_STEP_KIND = 'subagent_turn';
export const MAX_ACTIVE_SUBAGENTS_PER_PARENT = 5;
export const SUBAGENT_SYNC_TIMEOUT_MS = 600_000;
export const SUBAGENT_ASYNC_TIMEOUT_MS = 1_800_000;

const TERMINAL_RUN_STATUSES = new Set<RuntimeRunStatus>(['succeeded', 'failed', 'canceled', 'interrupted']);
const TERMINAL_STEP_STATUSES = new Set<RuntimeStepStatus>([
  'succeeded',
  'failed',
  'canceled',
  'interrupted',
  'skipped',
]);

export interface SubagentRuntimeInput {
  child_session_id: string;
  parent_session_id: string;
  profile_id: string;
  prompt: string;
  title: string;
  depth: number;
  max_steps: number;
  mode: 'sync' | 'async';
  timeout_ms: number;
  workspace_id: string | null;
}

interface SubagentRuntimeAdmissionBase extends SubagentRuntimeInput {
  owner_user_id: string;
  initiated_by_user_id: string;
  parent_runtime_run_id?: string | null;
}

export interface AdmitSubagentRuntimeInput extends SubagentRuntimeAdmissionBase {
  seed_message_id: string;
}

export interface SubagentRuntimeEnvelope {
  run: RuntimeRunRow;
  step: RuntimeStepRow;
}

/**
 * Atomically create the child transcript seed and its durable execution
 * envelope. A deterministic child/message identity makes tool-call replay
 * return the same Run instead of spawning a second child.
 */
export async function admitSubagentRuntimeRun(
  db: DatabaseProvider,
  input: AdmitSubagentRuntimeInput,
): Promise<SubagentRuntimeEnvelope & { idempotent: boolean }> {
  const parentRunId = await resolveParentRunId(db, input);
  const admitted = await db.runtime.admitSubagent({
    child_session_id: input.child_session_id,
    seed_message_id: input.seed_message_id,
    owner_user_id: input.owner_user_id,
    initiated_by_user_id: input.initiated_by_user_id,
    parent_session_id: input.parent_session_id,
    ...(parentRunId ? { parent_run_id: parentRunId } : {}),
    profile_id: input.profile_id,
    title: input.title,
    metadata: {
      spawn_depth: input.depth,
      parent_session_id: input.parent_session_id,
      spawned_by: 'spawn_session',
    },
    prompt: input.prompt,
    depth: input.depth,
    max_steps: input.max_steps,
    mode: input.mode,
    timeout_ms: input.timeout_ms,
    workspace_id: input.workspace_id,
    ...(input.mode === 'async' ? { active_limit: MAX_ACTIVE_SUBAGENTS_PER_PARENT } : {}),
    actor_user_id: input.initiated_by_user_id,
  });
  return { run: admitted.run, step: admitted.step, idempotent: admitted.idempotent };
}

export interface SubagentToolAssemblyInput {
  db: DatabaseProvider;
  runtimeRunId: string;
  childSessionId: string;
  ownerUserId: string;
  ownerRole: 'team' | 'super';
  profile: AgentProfile;
  depth: number;
  workspaceId: string | null;
}

export interface SubagentRuntimeDriverOptions {
  /** Production worker supplies the static registry; tests may inject an exact assembler. */
  toolRegistry?: ToolRegistry;
  assembleTools?: (input: SubagentToolAssemblyInput) => Promise<ToolRegistry> | ToolRegistry;
  generate?: AgentGenerate;
  resolveProfile?: (profileId: string) => Promise<AgentProfile>;
  resolveMemory?: (userId: string, role: UserRole) => Promise<string | null>;
  heartbeatIntervalMs?: number;
  cancelPollIntervalMs?: number;
  /** Sync inline execution only. Worker executions do not inherit an HTTP signal. */
  externalSignal?: AbortSignal;
  /** Sync inline execution atomically pre-claims Run + Step. */
  claimedStep?: RuntimeStepRow;
}

function payload(value: unknown): RuntimePayload {
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return item.toString(10);
    if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack ?? null };
    return item;
  });
  return encoded === undefined ? null : (JSON.parse(encoded) as RuntimePayload);
}

function parseInput(run: RuntimeRunRow): SubagentRuntimeInput {
  const value = safeJsonParse(run.input, null) as Record<string, unknown> | null;
  if (
    !value ||
    typeof value.child_session_id !== 'string' ||
    value.child_session_id !== run.source_id ||
    typeof value.parent_session_id !== 'string' ||
    typeof value.profile_id !== 'string' ||
    typeof value.prompt !== 'string' ||
    typeof value.title !== 'string' ||
    !Number.isSafeInteger(value.depth) ||
    Number(value.depth) < 1 ||
    !Number.isSafeInteger(value.max_steps) ||
    Number(value.max_steps) < 1 ||
    Number(value.max_steps) > 30 ||
    (value.mode !== 'sync' && value.mode !== 'async') ||
    !Number.isSafeInteger(value.timeout_ms) ||
    Number(value.timeout_ms) < 1_000 ||
    (value.workspace_id !== null && typeof value.workspace_id !== 'string')
  ) {
    throw new Error(`Subagent Runtime run ${run.id} has malformed durable input`);
  }
  return value as unknown as SubagentRuntimeInput;
}

async function resolveParentRunId(db: DatabaseProvider, input: SubagentRuntimeAdmissionBase): Promise<string | null> {
  if (input.parent_runtime_run_id) {
    // An explicitly propagated execution lineage is authoritative. Never
    // silently downgrade an invalid/canceled parent to a different active Run
    // found by session; admitSubagent locks and validates this exact row.
    return input.parent_runtime_run_id;
  }
  const inferred = await db.runtime.findActiveRunBySession(input.parent_session_id, input.owner_user_id);
  return inferred &&
    (inferred.status === 'claimed' || inferred.status === 'running') &&
    inferred.desired_state === 'run'
    ? inferred.id
    : null;
}

async function assembleCurrentTools(
  input: SubagentToolAssemblyInput,
  options: SubagentRuntimeDriverOptions,
): Promise<ToolRegistry> {
  if (options.assembleTools) return (await options.assembleTools(input)) ?? {};
  if (!options.toolRegistry) throw new Error('Subagent Runtime driver has no tool registry');
  // Dynamic import avoids a module-init cycle: tool-resolution constructs the
  // spawn tool, while a claimed spawn needs the same resolver at execution.
  const resolution = await import('../agent-runtime/tool-resolution.js');
  const agent = await import('../agent.js');
  const { effectiveTools } = await resolution.resolveEffectiveTools({
    userId: input.ownerUserId,
    userRole: input.ownerRole,
    profile: input.profile,
    profileId: input.profile.id,
  });
  const ids = resolution.childSpawnToolIds(effectiveTools, input.depth);
  const tools = agent.selectTools(
    options.toolRegistry,
    ids.filter((toolId) => !resolution.LAZY_TOOL_IDS.has(toolId)),
  );
  Object.assign(
    tools,
    resolution.buildLazyServerTools(input.db, ids, {
      userId: input.ownerUserId,
      userRole: input.ownerRole,
      sessionId: input.childSessionId,
      workspaceId: input.workspaceId,
      profileId: input.profile.id,
      toolRegistry: options.toolRegistry,
      unattended: true,
      runtimeRunId: input.runtimeRunId,
    }),
  );
  return tools;
}

async function transitionStepTerminal(
  db: DatabaseProvider,
  stepId: string,
  status: Extract<RuntimeStepStatus, 'succeeded' | 'failed' | 'canceled' | 'interrupted' | 'skipped'>,
  attempt: number,
  output: RuntimePayload,
  error?: { code: string; message: string },
  result?: RunAgentResult,
  authority?: { workerId: string; leaseMs: number },
): Promise<void> {
  const step = await db.runtime.getStep(stepId);
  if (!step || TERMINAL_STEP_STATUSES.has(step.status)) return;
  await db.runtime.transitionStep({
    id: step.id,
    expected_version: step.version,
    to_status: status,
    idempotency_key: `subagent:step:${status}:${step.id}:${attempt}`,
    ...(authority ? { worker_id: authority.workerId, lease_ms: authority.leaseMs } : {}),
    output,
    ...(error ? { error_code: error.code, error_message: error.message } : {}),
    ...(result
      ? {
          tokens_used: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
          requests_used: 1,
          duration_ms: result.durationMs,
        }
      : {}),
  });
}

async function transitionRunTerminal(
  db: DatabaseProvider,
  runId: string,
  status: Extract<RuntimeRunStatus, 'succeeded' | 'failed' | 'canceled' | 'interrupted'>,
  attempt: number,
  output: RuntimePayload,
  error?: { code: string; message: string },
  authority?: { workerId: string; leaseMs: number },
): Promise<void> {
  const run = await db.runtime.getRun(runId);
  if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return;
  await db.runtime.transitionRun({
    id: run.id,
    expected_version: run.version,
    to_status: status,
    desired_state: status === 'canceled' ? 'cancel' : run.desired_state,
    idempotency_key: `subagent:run:${status}:${run.id}:${attempt}`,
    ...(authority ? { worker_id: authority.workerId, lease_ms: authority.leaseMs } : {}),
    output,
    settled_at: new Date().toISOString(),
    ...(error ? { error_code: error.code, error_message: error.message } : {}),
  });
}

async function persistFailureNotice(db: DatabaseProvider, run: RuntimeRunRow, message: string): Promise<void> {
  await db.sessions
    .addMessageOnce(`subagent-runtime-terminal:${run.id}`, {
      session_id: run.source_id,
      role: 'assistant',
      content: message,
    })
    .catch((error) =>
      logger.warn('[subagent-runtime] could not append terminal notice', {
        runtimeRunId: run.id,
        error: toErrorMessage(error),
      }),
    );
}

async function claimStep(
  context: RuntimeDriverContext,
  options: SubagentRuntimeDriverOptions,
): Promise<RuntimeStepRow> {
  if (options.claimedStep) return options.claimedStep;
  const steps = await context.db.runtime.listSteps(context.run.id);
  let step = steps.find((item) => item.step_key === SUBAGENT_STEP_KEY && item.attempt === 1);
  if (!step) {
    const input = parseInput(context.run);
    step = await context.db.runtime.createStep({
      run_id: context.run.id,
      step_key: SUBAGENT_STEP_KEY,
      kind: SUBAGENT_STEP_KIND,
      input: payload({
        child_session_id: input.child_session_id,
        prompt: input.prompt,
        profile_id: input.profile_id,
        max_steps: input.max_steps,
      }),
      actor_user_id: context.run.initiated_by_user_id,
      idempotency_key: 'subagent:step:created',
    });
  }
  const claimed = await context.db.runtime.claimNextStep({
    run_id: context.run.id,
    step_id: step.id,
    worker_id: context.workerId,
    lease_ms: context.leaseMs,
  });
  if (!claimed) throw new RuntimeKernelError('runtime_lease_lost', 'Subagent Runtime step could not be claimed');
  return claimed;
}

/** Execute one already-claimed Subagent Run. */
export async function executeSubagentRuntimeRun(
  context: RuntimeDriverContext,
  options: SubagentRuntimeDriverOptions = {},
): Promise<void> {
  const { db, workerId, leaseMs } = context;
  let run = context.run;
  let step: RuntimeStepRow | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let cancelPoll: ReturnType<typeof setInterval> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  let abortReason: 'cancel' | 'timeout' | 'external' | 'lease' | null = null;
  const abortWith = (reason: typeof abortReason, error: Error) => {
    if (abort.signal.aborted) return;
    abortReason = reason;
    abort.abort(error);
  };
  const externalAbort = () => abortWith('external', new Error('Parent execution canceled'));

  try {
    if (run.kind !== 'subagent' || run.source_kind !== SUBAGENT_SOURCE_KIND) {
      throw new Error('Subagent Runtime driver received a non-subagent source');
    }
    if (run.lease_owner !== workerId || (run.status !== 'claimed' && run.status !== 'running')) {
      throw new RuntimeKernelError('runtime_lease_lost', `Subagent Runtime run ${run.id} has no claim for ${workerId}`);
    }
    const input = parseInput(run);
    const owner = await db.users.getById(run.owner_user_id);
    if (!owner || owner.status !== 'active' || (owner.role !== 'team' && owner.role !== 'super')) {
      throw new Error('Subagent owner is no longer an active internal user');
    }
    const ownerRole: 'team' | 'super' = owner.role;
    const session = await db.sessions.getById(input.child_session_id);
    if (
      !session ||
      session.user_id !== owner.id ||
      session.channel !== 'subagent' ||
      session.parent_session_id !== input.parent_session_id
    ) {
      throw new Error('Subagent source session is missing or no longer belongs to its owner');
    }
    const latestMessage = await db.sessions.getLatestMessage(session.id);
    if (!latestMessage || latestMessage.role !== 'user' || latestMessage.content !== input.prompt) {
      throw new SessionTranscriptChangedError('Subagent transcript changed before durable execution');
    }
    await assertPinnedProfileExecutionAccess(db, { id: owner.id, role: ownerRole }, input.profile_id, 'Subagent');
    const profile = options.resolveProfile
      ? await options.resolveProfile(input.profile_id)
      : await resolveProfileAsync(input.profile_id, db);
    const expectedProfileId = normalizeProfileId(input.profile_id) ?? input.profile_id;
    if (profile.id !== expectedProfileId) throw new Error('Subagent Agent reference did not resolve immutably');

    run = await db.runtime.transitionRun({
      id: run.id,
      expected_version: run.version,
      to_status: 'running',
      idempotency_key: `subagent:run:running:${run.id}:${run.attempt}`,
      actor_user_id: owner.id,
      worker_id: workerId,
      lease_ms: leaseMs,
    });
    // Claim the Step only after the Run's live lease fence succeeds. Otherwise
    // an expired Run claim could strand a fresh Step lease owned by a worker
    // that no longer has authority to perform provider/tool I/O.
    step = await claimStep({ ...context, run }, options);
    step = await db.runtime.transitionStep({
      id: step.id,
      expected_version: step.version,
      to_status: 'running',
      idempotency_key: `subagent:step:running:${step.id}:${step.attempt}`,
      actor_user_id: owner.id,
      worker_id: workerId,
      lease_ms: leaseMs,
    });

    const heartbeatInterval = options.heartbeatIntervalMs ?? Math.max(500, Math.floor(leaseMs / 3));
    let heartbeatBusy = false;
    heartbeat = setInterval(() => {
      if (heartbeatBusy || abort.signal.aborted || !step) return;
      heartbeatBusy = true;
      void (async () => {
        run = await db.runtime.heartbeatRun({
          id: run.id,
          expected_version: run.version,
          worker_id: workerId,
          lease_ms: leaseMs,
        });
        step = await db.runtime.heartbeatStep({
          id: step.id,
          expected_version: step.version,
          worker_id: workerId,
          lease_ms: leaseMs,
        });
      })()
        .catch((error) => abortWith('lease', error instanceof Error ? error : new Error(String(error))))
        .finally(() => {
          heartbeatBusy = false;
        });
    }, heartbeatInterval);
    heartbeat.unref();

    cancelPoll = setInterval(() => {
      if (abort.signal.aborted) return;
      void db.runtime
        .getRun(run.id)
        .then((latest) => {
          if (!latest || latest.desired_state === 'cancel' || latest.status === 'canceled') {
            abortWith('cancel', new Error('Subagent Runtime run canceled'));
          }
        })
        .catch((error) => abortWith('lease', error instanceof Error ? error : new Error(String(error))));
    }, options.cancelPollIntervalMs ?? 500);
    cancelPoll.unref();

    timeout = setTimeout(
      () => abortWith('timeout', new Error('Subagent Runtime execution timed out')),
      input.timeout_ms,
    );
    timeout.unref();
    if (options.externalSignal) {
      if (options.externalSignal.aborted) externalAbort();
      else options.externalSignal.addEventListener('abort', externalAbort, { once: true });
    }

    const currentTools = await assembleCurrentTools(
      {
        db,
        runtimeRunId: run.id,
        childSessionId: session.id,
        ownerUserId: owner.id,
        ownerRole,
        profile,
        depth: input.depth,
        workspaceId: input.workspace_id,
      },
      options,
    );
    const memory = await (options.resolveMemory ?? resolveMemoryContext)(owner.id, ownerRole as UserRole);
    const system = memory
      ? `${enrichSystemPrompt(profile)}\n\n## User Context\n${memory}`
      : enrichSystemPrompt(profile);
    const result = await runAgentInSession({
      db,
      sessionId: session.id,
      system,
      prompt: input.prompt,
      modelConfig: profile.model,
      tools: currentTools,
      maxSteps: input.max_steps,
      toolChoice: profile.tool_choice,
      ...(options.generate ? { generate: options.generate } : {}),
      abortSignal: abort.signal,
      usageContext: { profileId: profile.id, userId: owner.id, caller: 'spawn_session' },
      runtimeToolEvidence: {
        runId: run.id,
        stepId: step.id,
        actorUserId: owner.id,
        executionAuthority: { mode: 'leased', workerId, leaseMs },
        idempotencyPrefix: `subagent:${step.id}`,
      },
    });
    const latest = await db.runtime.getRun(run.id);
    if (abort.signal.aborted || latest?.desired_state === 'cancel') {
      const terminalOutput = payload({
        child_session_id: session.id,
        reason: abortReason ?? 'cancel',
        partial_result: result,
      });
      const authority = { workerId, leaseMs };
      await transitionStepTerminal(db, step.id, 'canceled', run.attempt, terminalOutput, undefined, result, authority);
      await transitionRunTerminal(db, run.id, 'canceled', run.attempt, terminalOutput, undefined, authority);
      return;
    }
    const output = payload({
      child_session_id: session.id,
      profile_id: profile.id,
      result: {
        text: result.text,
        usage: result.usage ?? null,
        duration_ms: result.durationMs,
        pipeline: result.pipeline,
        references: result.references,
        tool_evidence: result.toolEvidence,
        persisted: result.persisted,
      },
    });
    const authority = { workerId, leaseMs };
    await transitionStepTerminal(db, step.id, 'succeeded', run.attempt, output, undefined, result, authority);
    await transitionRunTerminal(db, run.id, 'succeeded', run.attempt, output, undefined, authority);
  } catch (error) {
    const latest = await db.runtime.getRun(run.id);
    const needsLeaseAuthority = run.status === 'claimed' || run.status === 'running' || step !== undefined;
    const liveLeaseExpiresAt = latest?.lease_expires_at ? Date.parse(latest.lease_expires_at) : Number.NaN;
    const lostAuthority =
      needsLeaseAuthority &&
      (!latest ||
        latest.lease_owner !== workerId ||
        (latest.status !== 'claimed' && latest.status !== 'running') ||
        !Number.isFinite(liveLeaseExpiresAt) ||
        liveLeaseExpiresAt <= Date.now());
    const heartbeatRejected =
      abortReason === 'lease' || (error instanceof RuntimeKernelError && error.code === 'runtime_lease_lost');
    // A Runtime cancel deliberately flips desired_state away from `run`, so a
    // racing heartbeat is rejected as lease_lost even though this worker still
    // owns the live wind-down lease. Preserve that distinction: cancel must be
    // settled now, while a genuinely reclaimed/expired lease must never write.
    const leaseLost = lostAuthority || (heartbeatRejected && latest?.desired_state !== 'cancel');
    if (leaseLost) {
      // A reclaimed claim may already belong to a replacement worker. The old
      // worker must not terminalize that worker's Run/Step using an unfenced
      // status transition; the stale reaper + driver reconciler own recovery.
      throw error;
    }
    const canceled = abortReason === 'cancel' || abortReason === 'external' || latest?.desired_state === 'cancel';
    const timedOut = abortReason === 'timeout';
    const status: 'canceled' | 'failed' = canceled ? 'canceled' : 'failed';
    const errorCode = canceled
      ? 'subagent_canceled'
      : timedOut
        ? 'subagent_timeout'
        : error instanceof SessionTranscriptChangedError
          ? 'subagent_transcript_changed'
          : 'subagent_failed';
    const message = toErrorMessage(error);
    const output = payload({
      child_session_id: run.source_id,
      status,
      reason: abortReason,
      error: { code: errorCode, message },
    });
    if (step) {
      await transitionStepTerminal(db, step.id, status, run.attempt, output, { code: errorCode, message }, undefined, {
        workerId,
        leaseMs,
      });
    } else {
      // Admission creates the Step before a worker validates current owner,
      // transcript and Agent access. A pre-claim validation failure must still
      // close that durable case instead of leaving a forever-queued Step under
      // a terminal Run.
      for (const pending of await db.runtime.listSteps(run.id)) {
        if (TERMINAL_STEP_STATUSES.has(pending.status)) continue;
        const pendingStatus = pending.status === 'queued' ? (status === 'canceled' ? 'canceled' : 'skipped') : status;
        await transitionStepTerminal(
          db,
          pending.id,
          pendingStatus,
          run.attempt,
          output,
          {
            code: errorCode,
            message,
          },
          undefined,
          { workerId, leaseMs },
        );
      }
    }
    await transitionRunTerminal(
      db,
      run.id,
      status,
      run.attempt,
      output,
      { code: errorCode, message },
      { workerId, leaseMs },
    );
    if (!(error instanceof SessionTranscriptChangedError)) {
      const notice = canceled
        ? '⚠️ 子任务已取消。'
        : timedOut
          ? `⏱️ 子任务超时(${Math.round(parseInput(run).timeout_ms / 1000)}s)已中止。`
          : `⚠️ 子任务执行失败: ${message}`;
      await persistFailureNotice(db, run, notice);
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (cancelPoll) clearInterval(cancelPoll);
    if (timeout) clearTimeout(timeout);
    options.externalSignal?.removeEventListener('abort', externalAbort);
  }
}

export function createSubagentRuntimeDriver(options: SubagentRuntimeDriverOptions = {}): RuntimeDriver {
  return (context) => executeSubagentRuntimeRun(context, options);
}

/**
 * Runtime is the Subagent domain: cancellation has no second mutable status
 * table to fake-sync. Route fencing calls this while holding the Run lock; the
 * only source check is that the child transcript still exists for this owner.
 */
export async function delegateSubagentRuntimeCancel(
  db: DatabaseProvider,
  run: RuntimeRunRow,
  command: RuntimeRunCommandType,
  mayDrive: boolean,
): Promise<void> {
  if (run.kind !== 'subagent' || run.source_kind !== SUBAGENT_SOURCE_KIND || command !== 'cancel') {
    throw new RuntimeKernelError('runtime_invalid_transition', `Subagent does not support ${command}`);
  }
  const session = await db.sessions.getById(run.source_id);
  // Runtime owns cancellation intent. A missing transcript must not make a
  // still-running worker impossible to stop; new deletes are guarded at the DB
  // service, but this also repairs any pre-guard/manual deletion.
  if (session && (session.user_id !== run.owner_user_id || session.channel !== 'subagent')) {
    throw new RuntimeKernelError('runtime_not_found', 'Subagent source session is missing');
  }
  if (!mayDrive && run.desired_state !== 'cancel') {
    throw new RuntimeKernelError('runtime_version_conflict', `Runtime run ${run.id} changed concurrently`);
  }
}

/** Finalize a queued cancel immediately; running/claimed drivers poll intent. */
export async function settleQueuedSubagentCancellation(
  db: DatabaseProvider,
  run: RuntimeRunRow,
  actorUserId: string,
): Promise<RuntimeRunRow> {
  if (run.kind !== 'subagent' || run.source_kind !== SUBAGENT_SOURCE_KIND) return run;
  if (run.status !== 'queued' || run.desired_state !== 'cancel') return run;
  const output = payload({
    child_session_id: run.source_id,
    status: 'canceled',
    reason: 'runtime_cancel_requested_before_claim',
    requested_by_user_id: actorUserId,
  });
  for (const step of await db.runtime.listSteps(run.id)) {
    if (step.status !== 'queued') continue;
    await db.runtime.transitionStep({
      id: step.id,
      expected_version: step.version,
      to_status: 'canceled',
      idempotency_key: `subagent:queued-cancel:step:${step.id}`,
      actor_user_id: actorUserId,
      output,
      error_code: 'subagent_canceled',
      error_message: 'Subagent canceled before execution was claimed',
    });
  }
  const latest = await db.runtime.getRun(run.id);
  if (!latest || latest.status !== 'queued' || latest.desired_state !== 'cancel') return latest ?? run;
  const canceled = await db.runtime.transitionRun({
    id: latest.id,
    expected_version: latest.version,
    to_status: 'canceled',
    desired_state: 'cancel',
    idempotency_key: `subagent:queued-cancel:run:${latest.id}`,
    actor_user_id: actorUserId,
    output,
    error_code: 'subagent_canceled',
    error_message: 'Subagent canceled before execution was claimed',
    settled_at: new Date().toISOString(),
  });
  await persistFailureNotice(db, canceled, '⚠️ 子任务已取消。');
  return canceled;
}

/**
 * Internal cancellation used when a synchronous parent disappears while a
 * background worker owns the exact Run. Execution Center uses the same two helpers
 * through its normal expected-version command fence.
 */
export async function requestSubagentRuntimeCancellation(
  db: DatabaseProvider,
  runId: string,
  actorUserId: string,
  idempotencyKey: string,
): Promise<RuntimeRunRow> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const run = await db.runtime.getRun(runId);
    if (!run) throw new RuntimeKernelError('runtime_not_found', 'Subagent Runtime run is missing');
    if (TERMINAL_RUN_STATUSES.has(run.status)) return run;
    if (run.desired_state === 'cancel') return settleQueuedSubagentCancellation(db, run, actorUserId);
    try {
      const fenced = await db.runtime.executeRunDomainCommand(
        {
          type: 'cancel',
          run_id: run.id,
          expected_version: run.version,
          idempotency_key: idempotencyKey,
        },
        actorUserId,
        ({ run: locked, may_drive: mayDrive }) => delegateSubagentRuntimeCancel(db, locked, 'cancel', mayDrive),
      );
      return settleQueuedSubagentCancellation(db, fenced.run, actorUserId);
    } catch (error) {
      if (!(error instanceof RuntimeKernelError) || error.code !== 'runtime_version_conflict' || attempt === 3) {
        throw error;
      }
    }
  }
  throw new RuntimeKernelError('runtime_version_conflict', `Runtime run ${runId} changed concurrently`);
}

/**
 * Close the Step/transcript side after the generic stale Run reaper marks a
 * max_attempts=1 child failed. The uncertain agent turn is never requeued.
 */
export async function reconcileReclaimedSubagentRun(db: DatabaseProvider, run: RuntimeRunRow): Promise<void> {
  if (run.kind !== 'subagent' || run.source_kind !== SUBAGENT_SOURCE_KIND) return;
  // A process may die after claiming the Step but before promoting the Run to
  // `running`. Runtime explicitly classifies that narrow claim-only boundary as
  // replay-safe. Release the Step lease before the freshly queued Run is driven
  // again; no model/provider/tool call has started at this point.
  if (run.status === 'queued' && run.error_code === 'runtime_claim_recovered') {
    for (const step of await db.runtime.listSteps(run.id)) {
      if (step.status !== 'claimed') continue;
      await db.runtime.transitionStep({
        id: step.id,
        expected_version: step.version,
        to_status: 'queued',
        idempotency_key: `subagent:claim-recovered:step:${step.id}:${run.attempt}`,
        output: payload({ reason: 'runtime_claim_recovered', replay_boundary: 'before_running' }),
      });
    }
    return;
  }
  if (run.status !== 'failed' && run.status !== 'canceled') return;
  await settleOpenRuntimeToolCalls(db, run.id, run.status === 'canceled' ? 'canceled' : 'uncertain', run.owner_user_id);
  for (const step of await db.runtime.listSteps(run.id)) {
    if (TERMINAL_STEP_STATUSES.has(step.status)) continue;
    const target: 'canceled' | 'interrupted' | 'skipped' =
      run.status === 'canceled' ? 'canceled' : step.status === 'queued' ? 'skipped' : 'interrupted';
    await transitionStepTerminal(
      db,
      step.id,
      target,
      run.attempt,
      payload({ reason: run.status === 'canceled' ? 'runtime_canceled' : 'runtime_lease_expired', replayed: false }),
      {
        code: run.status === 'canceled' ? 'subagent_canceled' : 'subagent_lease_expired',
        message:
          run.status === 'canceled'
            ? 'Subagent canceled'
            : 'Subagent lease expired; side-effectful turn was not replayed',
      },
    );
  }
  await persistFailureNotice(
    db,
    run,
    run.status === 'canceled'
      ? '⚠️ 子任务已取消。'
      : '⚠️ 子任务执行进程中断。为避免重复外部操作，本轮不会自动重放；请检查结果后手动重新发起。',
  );
}

/** Poll a sync Run that another local worker claimed before the inline caller. */
export async function waitForSubagentRuntimeRun(
  db: DatabaseProvider,
  runId: string,
  timeoutMs: number,
  signal?: AbortSignal,
  actorUserId?: string,
): Promise<RuntimeRunRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await db.runtime.getRun(runId);
    if (!run) throw new Error('Subagent Runtime run disappeared');
    if (TERMINAL_RUN_STATUSES.has(run.status)) return run;
    if (signal?.aborted) {
      if (actorUserId) {
        await requestSubagentRuntimeCancellation(db, runId, actorUserId, `subagent:parent-abort:${runId}`);
      }
      throw new Error('Parent execution canceled');
    }
    if (Date.now() >= deadline) {
      if (actorUserId) {
        await requestSubagentRuntimeCancellation(db, runId, actorUserId, `subagent:parent-timeout:${runId}`);
      }
      throw new Error('Timed out waiting for Subagent Runtime run');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Stable inline worker identity so sync execution participates in lease fencing. */
export function subagentInlineWorkerId(): string {
  return `subagent-inline-${process.pid}-${randomUUID().slice(0, 8)}`;
}
