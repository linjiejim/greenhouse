/**
 * Durable Eval Runtime driver.
 *
 * Eval remains the score/result fact store. Runtime owns queueing, leases,
 * recovery and cancellation intent. No bearer token is persisted: every
 * claimed attempt revalidates the original super actor and signs a fresh,
 * short-lived internal access token.
 */

import type { DatabaseProvider, EvalService, ResultUpdateData, RuntimeRunRow, RuntimeStepRow } from '@greenhouse/db';
import { RuntimeKernelError } from '@greenhouse/db';
import type { EvalResultWithQuestion, EvalRun } from '@greenhouse/types/eval';
import type { RuntimePayload, RuntimeRunStatus, RuntimeStepStatus } from '@greenhouse/types/runtime';
import { runWithConcurrency } from '@greenhouse/utils/concurrency';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { createAccessToken } from '../auth/token.js';
import { callAgent, computeFinalScore, computeSpeedScore, judgeAnswer } from '../eval.js';
import type { RuntimeDriver, RuntimeDriverContext } from './worker.js';

const EVAL_SOURCE_KIND = 'eval_run';
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_AGENT_TIMEOUT_MS = 150_000;

export interface DurableEvalConfig {
  actor_user_id: string;
  concurrency: number;
  profile_id: string;
  dataset_ids: number[];
  agent_timeout_ms: number;
  judge_model?: string;
  weights?: Record<string, number>;
}

export interface EvalCaseExecutionInput {
  result: EvalResultWithQuestion;
  accessToken: string;
  userId: string;
  profileId: string;
  apiBase: string;
  agentTimeoutMs: number;
  signal: AbortSignal;
}

export type EvalCaseExecutor = (input: EvalCaseExecutionInput) => Promise<ResultUpdateData>;

export interface EvalRuntimeDriverOptions {
  executeCase?: EvalCaseExecutor;
  /** Test seam; production uses one third of the current Runtime lease. */
  heartbeatIntervalMs?: number;
  /** Read-only durable-cancel poll; separate from permanent heartbeat events. */
  cancelPollIntervalMs?: number;
  apiBase?: string;
}

function parseConfig(run: EvalRun): DurableEvalConfig {
  let value: unknown;
  try {
    value = JSON.parse(run.config);
  } catch {
    throw new Error(`Eval run ${run.id} has malformed durable config`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Eval run ${run.id} has malformed durable config`);
  }
  const config = value as Record<string, unknown>;
  const concurrency = Number(config.concurrency ?? DEFAULT_CONCURRENCY);
  const timeout = Number(config.agent_timeout_ms ?? DEFAULT_AGENT_TIMEOUT_MS);
  const datasetIds = config.dataset_ids;
  if (
    typeof config.actor_user_id !== 'string' ||
    !config.actor_user_id.trim() ||
    typeof config.profile_id !== 'string' ||
    !config.profile_id.trim() ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 50 ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1_000 ||
    !Array.isArray(datasetIds) ||
    datasetIds.length === 0 ||
    datasetIds.some((id) => !Number.isSafeInteger(id) || Number(id) < 1)
  ) {
    throw new Error(`Eval run ${run.id} is missing its durable actor or execution request`);
  }
  return {
    actor_user_id: config.actor_user_id,
    concurrency,
    profile_id: config.profile_id,
    dataset_ids: datasetIds as number[],
    agent_timeout_ms: timeout,
    ...(typeof config.judge_model === 'string' ? { judge_model: config.judge_model } : {}),
    ...(config.weights && typeof config.weights === 'object' && !Array.isArray(config.weights)
      ? { weights: config.weights as Record<string, number> }
      : {}),
  };
}

export function durableEvalConfig(run: EvalRun): DurableEvalConfig {
  return parseConfig(run);
}

function runtimeInput(run: EvalRun, config: DurableEvalConfig): RuntimePayload {
  return {
    eval_run_id: run.id,
    profile_id: config.profile_id,
    dataset_ids: config.dataset_ids,
    concurrency: config.concurrency,
    agent_timeout_ms: config.agent_timeout_ms,
    actor_user_id: config.actor_user_id,
  };
}

function stepKey(resultId: number): string {
  return `eval-result:${resultId}`;
}

async function ensureEvalCaseSteps(
  db: DatabaseProvider,
  runtimeRun: RuntimeRunRow,
  results: Awaited<ReturnType<EvalService['listResults']>>,
): Promise<void> {
  for (const result of results) {
    await db.runtime.createStep({
      run_id: runtimeRun.id,
      step_key: stepKey(result.id),
      kind: 'eval_case',
      input: {
        eval_run_id: result.run_id,
        eval_result_id: result.id,
        dataset_id: result.dataset_id,
      },
      actor_user_id: runtimeRun.initiated_by_user_id,
    });
  }
}

/** Idempotently close the Eval→Runtime creation crash window. */
export async function ensureEvalRuntimeRun(db: DatabaseProvider, evalRun: EvalRun): Promise<RuntimeRunRow> {
  const config = parseConfig(evalRun);
  const runtimeRun = await db.runtime.createRun({
    kind: 'eval',
    owner_user_id: config.actor_user_id,
    initiated_by_user_id: config.actor_user_id,
    source_kind: EVAL_SOURCE_KIND,
    source_id: evalRun.id,
    input: runtimeInput(evalRun, config),
    actor_user_id: config.actor_user_id,
    max_attempts: 3,
  });
  await ensureEvalCaseSteps(db, runtimeRun, await db.eval.listResults(evalRun.id));
  return runtimeRun;
}

/** Boot repair for a process crash after the domain request committed. */
export async function reconcileEvalRuntimeRuns(db: DatabaseProvider): Promise<void> {
  for (const run of await db.eval.listRecoverableRuns(1_000)) {
    try {
      parseConfig(run);
    } catch (error) {
      await db.eval.failRun(run.id);
      logger.error('[eval-runtime] rejected an unrecoverable Eval request', {
        evalRunId: run.id,
        error: toErrorMessage(error),
      });
      continue;
    }
    try {
      await ensureEvalRuntimeRun(db, run);
    } catch (error) {
      logger.error('[eval-runtime] could not recover queued Eval request', {
        evalRunId: run.id,
        error: toErrorMessage(error),
      });
    }
  }
}

export const executeEvalCase: EvalCaseExecutor = async (input) => {
  const groundTruth = JSON.parse(input.result.ground_truth) as unknown;
  if (!Array.isArray(groundTruth) || groundTruth.some((fact) => typeof fact !== 'string')) {
    throw new Error(`Eval dataset ${input.result.dataset_id} has malformed ground_truth`);
  }
  const agent = await callAgent(
    input.apiBase,
    input.result.question,
    input.accessToken,
    input.agentTimeoutMs,
    input.profileId,
    input.signal,
  );
  if (input.signal.aborted) throw input.signal.reason;
  const judge = await judgeAnswer(
    input.result.question,
    groundTruth,
    agent.answer,
    agent.references.map((reference) => reference.title),
    input.result.is_negative === 1,
    input.userId,
    2,
    input.signal,
  );
  if (input.signal.aborted) throw input.signal.reason;
  const speed = computeSpeedScore({
    ttfbMs: agent.ttfbMs,
    totalMs: agent.durationMs,
    answerLength: agent.answer.length,
  });
  const score = computeFinalScore({
    accuracy: judge.accuracy.score,
    completeness: judge.completeness.score,
    relevance: judge.relevance.score,
    speed: speed.score,
  });
  return {
    answer: agent.answer,
    references_used: agent.references,
    duration_ms: agent.durationMs,
    ttfb_ms: agent.ttfbMs,
    answer_length: agent.answer.length,
    session_id: agent.sessionId,
    score_accuracy: judge.accuracy.score,
    score_completeness: judge.completeness.score,
    score_relevance: judge.relevance.score,
    score_speed: speed.score,
    score_final: score,
    judge_reasoning: {
      accuracy: judge.accuracy,
      completeness: judge.completeness,
      relevance: judge.relevance,
      speed: {
        score: speed.score,
        ttfbScore: speed.ttfbScore,
        throughputScore: speed.throughputScore,
        reason: `TTFB ${agent.ttfbMs}ms, total ${agent.durationMs}ms, output ${agent.answer.length} chars, throughput ${speed.throughputCps} chars/s`,
      },
    },
    status: 'completed',
  };
};

interface LeaseKeeper<T> {
  current(): T;
  stop(): Promise<T>;
}

interface CancelPoller {
  stop(): Promise<void>;
}

function startCancellationPoll(input: {
  db: DatabaseProvider;
  runtimeRunId: string;
  evalRunId: string;
  intervalMs: number;
  abort: AbortController;
}): CancelPoller {
  let chain = Promise.resolve();
  const timer = setInterval(
    () => {
      chain = chain
        .then(async () => {
          if (input.abort.signal.aborted) return;
          const [runtime, evalRun] = await Promise.all([
            input.db.runtime.getRun(input.runtimeRunId),
            input.db.eval.getRun(input.evalRunId),
          ]);
          if (runtime?.desired_state === 'cancel' || evalRun?.status === 'cancelled') {
            input.abort.abort(new Error('Eval run cancellation requested'));
          }
        })
        .catch((error) => input.abort.abort(error));
    },
    Math.max(input.intervalMs, 25),
  );
  timer.unref();
  return {
    stop: async () => {
      clearInterval(timer);
      await chain;
    },
  };
}

function startLeaseKeeper<T>(input: {
  initial: T;
  intervalMs: number;
  heartbeat: (current: T) => Promise<T>;
  abort: AbortController;
}): LeaseKeeper<T> {
  let current = input.initial;
  let chain = Promise.resolve();
  const timer = setInterval(
    () => {
      chain = chain.then(async () => {
        if (input.abort.signal.aborted) return;
        try {
          current = await input.heartbeat(current);
        } catch (error) {
          input.abort.abort(error);
        }
      });
    },
    Math.max(input.intervalMs, 10),
  );
  timer.unref();
  return {
    current: () => current,
    stop: async () => {
      clearInterval(timer);
      await chain;
      return current;
    },
  };
}

function terminalResultStatus(status: string): boolean {
  return status === 'completed' || status === 'error' || status === 'cancelled';
}

function uniqueEvalResults(results: EvalResultWithQuestion[]): EvalResultWithQuestion[] {
  return [...new Map(results.map((result) => [result.id, result])).values()];
}

function desiredStepTerminal(status: string): RuntimeStepStatus {
  if (status === 'completed') return 'succeeded';
  if (status === 'error') return 'failed';
  return 'canceled';
}

async function waitUntilExpired(step: RuntimeStepRow, signal: AbortSignal): Promise<void> {
  const remaining = Math.max(0, Date.parse(step.lease_expires_at ?? '') - Date.now() + 25);
  if (remaining === 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, remaining);
    timer.unref();
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

async function latestCaseStep(
  db: DatabaseProvider,
  runtimeRun: RuntimeRunRow,
  result: EvalResultWithQuestion,
): Promise<RuntimeStepRow> {
  const key = stepKey(result.id);
  let matches = (await db.runtime.listSteps(runtimeRun.id)).filter((step) => step.step_key === key);
  if (matches.length === 0) {
    await ensureEvalCaseSteps(db, runtimeRun, [result]);
    matches = (await db.runtime.listSteps(runtimeRun.id)).filter((step) => step.step_key === key);
  }
  const step = matches.sort((left, right) => right.attempt - left.attempt)[0];
  if (!step) throw new Error(`Runtime step for Eval result ${result.id} is missing`);
  return step;
}

async function runnableCaseStep(input: {
  db: DatabaseProvider;
  runtimeRun: RuntimeRunRow;
  result: EvalResultWithQuestion;
  workerId: string;
  leaseMs: number;
  signal: AbortSignal;
}): Promise<RuntimeStepRow> {
  let step = await latestCaseStep(input.db, input.runtimeRun, input.result);
  if (step.status === 'claimed' || step.status === 'running') {
    await waitUntilExpired(step, input.signal);
    const fresh = await input.db.runtime.getStep(step.id);
    if (!fresh) throw new Error(`Runtime step ${step.id} disappeared`);
    if (fresh.status === 'claimed' || fresh.status === 'running') {
      const requeued = await input.db.runtime.requeueStaleStep({
        id: fresh.id,
        expected_version: fresh.version,
        idempotency_key: `eval-step-recover:${fresh.id}:${fresh.attempt}`,
        checkpoint: {
          eval_result_status: input.result.status,
          external_writes: 'eval-session-and-model-only',
        },
      });
      step = requeued.replacement;
    } else {
      step = fresh;
    }
  }
  if ((step.status === 'failed' || step.status === 'interrupted') && input.result.status === 'pending') {
    step = await input.db.runtime.transitionStep({
      id: step.id,
      expected_version: step.version,
      to_status: 'queued',
      idempotency_key: `eval-step-retry:${step.id}:${step.attempt}`,
    });
  }
  if (step.status !== 'queued') return step;
  const claimed = await input.db.runtime.claimNextStep({
    worker_id: input.workerId,
    lease_ms: input.leaseMs,
    run_id: input.runtimeRun.id,
    step_id: step.id,
  });
  if (!claimed) throw new Error(`Runtime step ${step.id} could not be claimed under its Eval Run lease`);
  return input.db.runtime.transitionStep({
    id: claimed.id,
    expected_version: claimed.version,
    to_status: 'running',
    idempotency_key: `eval-step-running:${claimed.id}:${claimed.attempt}`,
    worker_id: input.workerId,
    lease_ms: input.leaseMs,
  });
}

async function settleCaseStep(
  db: DatabaseProvider,
  step: RuntimeStepRow,
  status: RuntimeStepStatus,
  result: EvalResultWithQuestion,
  lease?: { workerId: string; leaseMs: number },
): Promise<RuntimeStepRow> {
  if (step.status === status) return step;
  if (['succeeded', 'failed', 'canceled', 'skipped'].includes(step.status)) return step;
  if (step.status === 'queued' && status === 'canceled') {
    return db.runtime.transitionStep({
      id: step.id,
      expected_version: step.version,
      to_status: status,
      idempotency_key: `eval-step-${status}:${step.id}:${step.attempt}`,
      output: { eval_result_id: result.id, eval_result_status: result.status },
    });
  }
  let running = step;
  if (running.status === 'claimed') {
    running = await db.runtime.transitionStep({
      id: running.id,
      expected_version: running.version,
      to_status: 'running',
      idempotency_key: `eval-step-running:${running.id}:${running.attempt}`,
      ...(lease ? { worker_id: lease.workerId, lease_ms: lease.leaseMs } : {}),
    });
  }
  if (running.status !== 'running') return running;
  return db.runtime.transitionStep({
    id: running.id,
    expected_version: running.version,
    to_status: status,
    idempotency_key: `eval-step-${status}:${running.id}:${running.attempt}`,
    ...(lease ? { worker_id: lease.workerId, lease_ms: lease.leaseMs } : {}),
    output: { eval_result_id: result.id, eval_result_status: result.status },
    ...(status === 'failed' ? { error_code: 'eval_case_failed', error_message: result.error } : {}),
  });
}

async function transitionRunTerminal(input: {
  db: DatabaseProvider;
  runtimeRunId: string;
  workerId: string;
  leaseMs: number;
  toStatus: Extract<RuntimeRunStatus, 'succeeded' | 'failed' | 'canceled'>;
  attempt: number;
  output?: RuntimePayload;
  error?: unknown;
}): Promise<void> {
  const latest = await input.db.runtime.getRun(input.runtimeRunId);
  if (!latest || ['succeeded', 'failed', 'canceled', 'interrupted'].includes(latest.status)) return;
  if (latest.lease_owner !== input.workerId || (latest.status !== 'claimed' && latest.status !== 'running')) {
    throw new RuntimeKernelError('runtime_lease_lost', `Eval Runtime run ${input.runtimeRunId} lease was lost`);
  }
  await input.db.runtime.transitionRun({
    id: latest.id,
    expected_version: latest.version,
    to_status: input.toStatus,
    desired_state: input.toStatus === 'canceled' ? 'cancel' : latest.desired_state,
    idempotency_key: `eval-run-${input.toStatus}:${latest.id}:${input.attempt}`,
    worker_id: input.workerId,
    lease_ms: input.leaseMs,
    ...(input.output ? { output: input.output } : {}),
    ...(input.toStatus === 'failed'
      ? { error_code: 'eval_driver_failed', error_message: toErrorMessage(input.error) }
      : {}),
  });
}

async function cancelRemainingSteps(db: DatabaseProvider, runtimeRunId: string): Promise<void> {
  for (const step of await db.runtime.listSteps(runtimeRunId)) {
    if (step.status === 'queued' || step.status === 'claimed' || step.status === 'running') {
      try {
        await db.runtime.transitionStep({
          id: step.id,
          expected_version: step.version,
          to_status: 'canceled',
          idempotency_key: `eval-step-canceled:${step.id}:${step.attempt}`,
          output: { reason: 'eval_run_canceled' },
        });
      } catch (error) {
        if (!(error instanceof RuntimeKernelError) || error.code !== 'runtime_version_conflict') throw error;
      }
    }
  }
}

/** Immediately close all pre-created case Steps when a queued Eval is canceled. */
export async function settleQueuedEvalCancellation(
  db: DatabaseProvider,
  run: RuntimeRunRow,
  actorUserId: string,
): Promise<RuntimeRunRow> {
  if (run.kind !== 'eval' || run.source_kind !== EVAL_SOURCE_KIND) return run;
  if (run.status !== 'queued' || run.desired_state !== 'cancel') return run;
  await cancelRemainingSteps(db, run.id);
  const latest = await db.runtime.getRun(run.id);
  if (!latest || latest.status !== 'queued' || latest.desired_state !== 'cancel') return latest ?? run;
  return db.runtime.transitionRun({
    id: latest.id,
    expected_version: latest.version,
    to_status: 'canceled',
    desired_state: 'cancel',
    idempotency_key: `eval-cancel-terminal:${latest.id}`,
    actor_user_id: actorUserId,
    output: { eval_run_id: latest.source_id, reason: 'runtime_cancel_requested_before_claim' },
    settled_at: new Date().toISOString(),
  });
}

/**
 * Project a generic terminal lease-reclaim back into Eval's domain tables.
 * Without this hook the third exhausted Runtime attempt would remain
 * `running` forever in Eval even though its execution envelope is failed.
 */
export async function reconcileReclaimedEvalRun(db: DatabaseProvider, run: RuntimeRunRow): Promise<void> {
  if (run.kind !== 'eval' || run.source_kind !== EVAL_SOURCE_KIND) return;
  if (run.status !== 'failed' && run.status !== 'canceled') return;

  if (run.status === 'canceled') await db.eval.cancelRun(run.source_id);
  else await db.eval.failRun(run.source_id);

  for (const step of await db.runtime.listSteps(run.id)) {
    if (['succeeded', 'failed', 'canceled', 'interrupted', 'skipped'].includes(step.status)) continue;
    const target = run.status === 'canceled' ? 'canceled' : step.status === 'queued' ? 'skipped' : 'interrupted';
    try {
      await db.runtime.transitionStep({
        id: step.id,
        expected_version: step.version,
        to_status: target,
        idempotency_key: `eval-reclaimed-${target}:${step.id}:${step.attempt}`,
        output: { reason: run.error_code ?? 'runtime_lease_expired', replayed: false },
        ...(run.status === 'failed'
          ? {
              error_code: 'eval_runtime_attempts_exhausted',
              error_message: run.error_message ?? 'Eval Runtime attempts were exhausted',
            }
          : {}),
      });
    } catch (error) {
      if (!(error instanceof RuntimeKernelError) || error.code !== 'runtime_version_conflict') throw error;
      const latest = await db.runtime.getStep(step.id);
      if (!latest || !['succeeded', 'failed', 'canceled', 'interrupted', 'skipped'].includes(latest.status)) {
        throw error;
      }
    }
  }
}

export function createEvalRuntimeDriver(options: EvalRuntimeDriverOptions = {}): RuntimeDriver {
  const executeCase = options.executeCase ?? executeEvalCase;
  return async (context: RuntimeDriverContext): Promise<void> => {
    const { db, run, workerId, leaseMs } = context;
    if (run.kind !== 'eval' || run.source_kind !== EVAL_SOURCE_KIND) {
      await transitionRunTerminal({
        db,
        runtimeRunId: run.id,
        workerId,
        leaseMs,
        toStatus: 'failed',
        attempt: run.attempt,
        error: new Error('Eval Runtime driver received a non-Eval source'),
      });
      return;
    }

    const evalRun = await db.eval.getRun(run.source_id);
    if (!evalRun) {
      await transitionRunTerminal({
        db,
        runtimeRunId: run.id,
        workerId,
        leaseMs,
        toStatus: 'failed',
        attempt: run.attempt,
        error: new Error(`Eval source run ${run.source_id} is missing`),
      });
      return;
    }

    let config: DurableEvalConfig;
    let activeRunLease: LeaseKeeper<RuntimeRunRow> | undefined;
    let cancelPoller: CancelPoller | undefined;
    try {
      config = parseConfig(evalRun);
      const actor = await db.users.getById(config.actor_user_id);
      if (!actor || actor.status !== 'active' || actor.role !== 'super' || actor.id !== run.owner_user_id) {
        throw new Error('Eval Runtime actor must remain an active super user');
      }
      if (evalRun.status === 'cancelled' || run.desired_state === 'cancel') {
        await db.eval.cancelRun(evalRun.id);
        await cancelRemainingSteps(db, run.id);
        await transitionRunTerminal({
          db,
          runtimeRunId: run.id,
          workerId,
          leaseMs,
          toStatus: 'canceled',
          attempt: run.attempt,
        });
        return;
      }
      if (evalRun.status === 'completed' || evalRun.status === 'failed') {
        await transitionRunTerminal({
          db,
          runtimeRunId: run.id,
          workerId,
          leaseMs,
          toStatus: evalRun.status === 'completed' ? 'succeeded' : 'failed',
          attempt: run.attempt,
          ...(evalRun.status === 'completed'
            ? { output: { eval_run_id: evalRun.id, completed: evalRun.completed } }
            : { error: new Error('Eval domain run was already failed') }),
        });
        return;
      }

      let runtimeRun = await db.runtime.transitionRun({
        id: run.id,
        expected_version: run.version,
        to_status: 'running',
        idempotency_key: `eval-run-running:${run.id}:${run.attempt}`,
        actor_user_id: config.actor_user_id,
        worker_id: workerId,
        lease_ms: leaseMs,
      });
      const domainRun = await db.eval.markRunRunning(evalRun.id);
      if (!domainRun || domainRun.status === 'cancelled') {
        await cancelRemainingSteps(db, run.id);
        await transitionRunTerminal({
          db,
          runtimeRunId: run.id,
          workerId,
          leaseMs,
          toStatus: 'canceled',
          attempt: run.attempt,
        });
        return;
      }

      const abort = new AbortController();
      const heartbeatInterval = options.heartbeatIntervalMs ?? Math.max(250, Math.floor(leaseMs / 3));
      const runLease = startLeaseKeeper({
        initial: runtimeRun,
        intervalMs: heartbeatInterval,
        abort,
        heartbeat: async (current) => {
          const updated = await db.runtime.heartbeatRun({
            id: current.id,
            expected_version: current.version,
            worker_id: workerId,
            lease_ms: leaseMs,
          });
          runtimeRun = updated;
          return updated;
        },
      });
      activeRunLease = runLease;
      cancelPoller = startCancellationPoll({
        db,
        runtimeRunId: run.id,
        evalRunId: evalRun.id,
        intervalMs: options.cancelPollIntervalMs ?? 500,
        abort,
      });

      let results = uniqueEvalResults(await db.eval.getRunResults(evalRun.id));
      let completed = results.filter((result) => terminalResultStatus(result.status)).length;
      await ensureEvalCaseSteps(db, runtimeRun, results);

      // Repair the step side of a crash where the Eval result committed first.
      for (const result of results.filter((item) => terminalResultStatus(item.status))) {
        if (abort.signal.aborted) break;
        const step = await runnableCaseStep({ db, runtimeRun, result, workerId, leaseMs, signal: abort.signal });
        await settleCaseStep(db, step, desiredStepTerminal(result.status), result, { workerId, leaseMs });
      }

      await runWithConcurrency(
        results.filter((result) => result.status === 'pending'),
        config.concurrency,
        async (result) => {
          if (abort.signal.aborted) return;
          let step = await runnableCaseStep({ db, runtimeRun, result, workerId, leaseMs, signal: abort.signal });
          const stepAbort = new AbortController();
          const combinedAbort = AbortSignal.any([abort.signal, stepAbort.signal]);
          const stepLease = startLeaseKeeper({
            initial: step,
            intervalMs: heartbeatInterval,
            abort: stepAbort,
            heartbeat: (current) =>
              db.runtime.heartbeatStep({
                id: current.id,
                expected_version: current.version,
                worker_id: workerId,
                lease_ms: leaseMs,
              }),
          });
          try {
            const currentActor = await db.users.getById(actor.id);
            if (!currentActor || currentActor.status !== 'active' || currentActor.role !== 'super') {
              throw new Error('Eval Runtime actor is no longer an active super user');
            }
            const update = await executeCase({
              result,
              accessToken: createAccessToken(currentActor.id, currentActor.role, currentActor.auth_version),
              userId: actor.id,
              profileId: config.profile_id,
              apiBase: options.apiBase ?? `http://localhost:${process.env.API_PORT ?? '3000'}`,
              agentTimeoutMs: config.agent_timeout_ms,
              signal: combinedAbort,
            });
            if (combinedAbort.aborted) {
              step = await stepLease.stop();
              if (stepAbort.signal.aborted && !abort.signal.aborted) abort.abort(stepAbort.signal.reason);
              return;
            }
            const saved = await db.eval.updatePendingResult(result.id, { ...update, status: 'completed' });
            step = await stepLease.stop();
            if (!saved) {
              abort.abort(new Error('Eval run was canceled while a case was completing'));
              await settleCaseStep(db, step, 'canceled', { ...result, status: 'cancelled' }, { workerId, leaseMs });
              return;
            }
            const completedResult = { ...result, ...update, status: 'completed' } as EvalResultWithQuestion;
            await settleCaseStep(db, step, 'succeeded', completedResult, { workerId, leaseMs });
            completed += 1;
            await db.eval.updateRunProgress(evalRun.id, completed);
          } catch (error) {
            step = await stepLease.stop();
            if (stepAbort.signal.aborted && !abort.signal.aborted) abort.abort(stepAbort.signal.reason);
            if (abort.signal.aborted || combinedAbort.aborted) return;
            const message = toErrorMessage(error);
            const saved = await db.eval.updatePendingResult(result.id, { status: 'error', error: message });
            if (!saved) {
              abort.abort(new Error('Eval run was canceled while a case was failing'));
              await settleCaseStep(db, step, 'canceled', { ...result, status: 'cancelled' }, { workerId, leaseMs });
              return;
            }
            await settleCaseStep(
              db,
              step,
              'failed',
              { ...result, status: 'error', error: message },
              {
                workerId,
                leaseMs,
              },
            );
            completed += 1;
            await db.eval.updateRunProgress(evalRun.id, completed);
          }
        },
        abort.signal,
      );

      await cancelPoller.stop();
      cancelPoller = undefined;
      await runLease.stop();
      activeRunLease = undefined;
      const latestDomain = await db.eval.getRun(evalRun.id);
      const latestRuntime = await db.runtime.getRun(run.id);
      if (latestDomain?.status === 'cancelled' || latestRuntime?.desired_state === 'cancel') {
        await db.eval.cancelRun(evalRun.id);
        await cancelRemainingSteps(db, run.id);
        await transitionRunTerminal({
          db,
          runtimeRunId: run.id,
          workerId,
          leaseMs,
          toStatus: 'canceled',
          attempt: run.attempt,
        });
        return;
      }
      if (abort.signal.aborted) {
        const reason = abort.signal.reason;
        if (reason instanceof RuntimeKernelError) throw reason;
        throw new RuntimeKernelError('runtime_lease_lost', 'Eval Runtime lease heartbeat stopped');
      }

      results = uniqueEvalResults(await db.eval.getRunResults(evalRun.id));
      if (results.some((result) => result.status === 'pending')) {
        throw new Error('Eval driver stopped with pending cases and no cancellation intent');
      }
      const finalRun = await db.eval.finalizeRun(evalRun.id);
      await transitionRunTerminal({
        db,
        runtimeRunId: run.id,
        workerId,
        leaseMs,
        toStatus: 'succeeded',
        attempt: run.attempt,
        output: {
          eval_run_id: evalRun.id,
          completed: finalRun?.completed ?? results.length,
          passed: finalRun?.passed ?? results.filter((result) => result.status === 'completed').length,
          failed: finalRun?.failed ?? results.filter((result) => result.status === 'error').length,
          avg_score: finalRun?.avg_score ?? null,
        },
      });
    } catch (error) {
      await cancelPoller?.stop();
      await activeRunLease?.stop();
      const latest = await db.runtime.getRun(run.id);
      const liveLeaseExpiresAt = latest?.lease_expires_at ? Date.parse(latest.lease_expires_at) : Number.NaN;
      const lostAuthority =
        !latest ||
        latest.lease_owner !== workerId ||
        (latest.status !== 'claimed' && latest.status !== 'running') ||
        !Number.isFinite(liveLeaseExpiresAt) ||
        liveLeaseExpiresAt <= Date.now();
      const heartbeatRejected = error instanceof RuntimeKernelError && error.code === 'runtime_lease_lost';
      if (lostAuthority || (heartbeatRejected && latest?.desired_state !== 'cancel')) throw error;
      if (latest?.desired_state === 'cancel' || (await db.eval.getRun(evalRun.id))?.status === 'cancelled') {
        await db.eval.cancelRun(evalRun.id);
        await cancelRemainingSteps(db, run.id);
        await transitionRunTerminal({
          db,
          runtimeRunId: run.id,
          workerId,
          leaseMs,
          toStatus: 'canceled',
          attempt: run.attempt,
        });
        return;
      }
      await db.eval.failRun(evalRun.id);
      await transitionRunTerminal({
        db,
        runtimeRunId: run.id,
        workerId,
        leaseMs,
        toStatus: 'failed',
        attempt: run.attempt,
        error,
      });
    }
  };
}
