/**
 * Durable Runtime trace for one ordinary Chat assistant turn.
 *
 * Chat remains the execution authority: the in-process ChatRun owns streaming,
 * cancellation and transcript persistence. Runtime records the complete input,
 * provider envelope, raw tool evidence and terminal outcome. It never claims or
 * replays a Chat turn.
 */

import type { DatabaseProvider, RuntimeRunRow, RuntimeStepRow, RuntimeToolCallRow } from '@greenhouse/db';
import {
  canTransitionRuntimeRun,
  canTransitionRuntimeStep,
  type RuntimePayload,
  type RuntimeRunStatus,
  type RuntimeStepStatus,
} from '@greenhouse/types/runtime';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';

const CHAT_SOURCE_KIND = 'chat_turn';
const CHAT_STEP_KEY = 'chat_turn';

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

const TERMINAL_RUN_STATUSES = new Set<RuntimeRunStatus>(['succeeded', 'failed', 'canceled', 'interrupted']);
const TERMINAL_STEP_STATUSES = new Set<RuntimeStepStatus>([
  'succeeded',
  'failed',
  'canceled',
  'interrupted',
  'skipped',
]);

export type ChatRuntimeTerminalStatus = 'succeeded' | 'failed' | 'canceled' | 'interrupted';

export function chatRuntimeResultMessageId(runId: string, status: ChatRuntimeTerminalStatus): string {
  return `chat-runtime-result:${runId}:${status}`;
}

export interface ChatRuntimeTrace {
  runId: string;
  stepId: string;
  actorUserId: string;
}

export interface StartChatRuntimeTraceInput {
  ownerUserId: string;
  sessionId?: string | null;
  sourceId: string;
  input: unknown;
}

export interface SettleChatRuntimeTraceInput {
  status: ChatRuntimeTerminalStatus;
  output: unknown;
  errorCode?: string;
  errorMessage?: string;
  tokensUsed?: number;
  requestsUsed?: number;
  costMicros?: number;
  durationMs?: number;
}

/**
 * Convert provider/tool data into Runtime's exact JSON contract.
 *
 * Nothing is excerpted or expired. BigInts are represented as decimal strings
 * because JSON has no integer type capable of carrying them losslessly.
 */
export function chatRuntimePayload(value: unknown): RuntimePayload {
  if (value === undefined) return null;
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return item.toString(10);
    if (item instanceof Error) {
      return { name: item.name, message: item.message, stack: item.stack ?? null };
    }
    return item;
  });
  if (encoded === undefined) return null;
  return JSON.parse(encoded) as RuntimePayload;
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

async function advanceRun(
  db: DatabaseProvider,
  run: RuntimeRunRow,
  target: RuntimeRunStatus,
  input: {
    actorUserId: string;
    output?: RuntimePayload;
    errorCode?: string;
    errorMessage?: string;
  },
): Promise<RuntimeRunRow> {
  if (TERMINAL_RUN_STATUSES.has(run.status) && run.status !== target) return run;
  const path = findPath(run.status, target, RUN_STATUSES, canTransitionRuntimeRun);
  if (!path) throw new Error(`Chat Runtime run cannot advance from ${run.status} to ${target}`);
  let current = run;
  for (const status of path) {
    const terminal = TERMINAL_RUN_STATUSES.has(status);
    current = await db.runtime.transitionRun({
      id: current.id,
      expected_version: current.version,
      to_status: status,
      ...(status === 'running' ? { projection_only: true } : {}),
      idempotency_key: `chat:${current.id}:run:${current.version}:${status}`,
      actor_user_id: input.actorUserId,
      ...(status === 'canceled' ? { desired_state: 'cancel' as const } : {}),
      ...(terminal ? { output: input.output ?? null, settled_at: new Date().toISOString() } : {}),
      ...(terminal && status !== 'succeeded'
        ? {
            error_code: input.errorCode ?? `chat_${status}`,
            error_message: input.errorMessage ?? `Chat turn ${status}`,
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
  input: {
    actorUserId: string;
    output?: RuntimePayload;
    errorCode?: string;
    errorMessage?: string;
    tokensUsed?: number;
    requestsUsed?: number;
    costMicros?: number;
    durationMs?: number;
  },
): Promise<RuntimeStepRow> {
  if (TERMINAL_STEP_STATUSES.has(step.status) && step.status !== target) return step;
  const path = findPath(step.status, target, STEP_STATUSES, canTransitionRuntimeStep);
  if (!path) throw new Error(`Chat Runtime step cannot advance from ${step.status} to ${target}`);
  let current = step;
  for (const status of path) {
    const terminal = TERMINAL_STEP_STATUSES.has(status);
    current = await db.runtime.transitionStep({
      id: current.id,
      expected_version: current.version,
      to_status: status,
      ...(status === 'running' ? { projection_only: true } : {}),
      idempotency_key: `chat:${current.run_id}:step:${current.id}:${current.version}:${status}`,
      actor_user_id: input.actorUserId,
      ...(terminal ? { output: input.output ?? null } : {}),
      ...(terminal && status !== 'succeeded'
        ? {
            error_code: input.errorCode ?? `chat_${status}`,
            error_message: input.errorMessage ?? `Chat turn ${status}`,
          }
        : {}),
      ...(terminal && input.tokensUsed !== undefined ? { tokens_used: Math.max(0, input.tokensUsed) } : {}),
      ...(terminal && input.requestsUsed !== undefined ? { requests_used: Math.max(0, input.requestsUsed) } : {}),
      ...(terminal && input.costMicros !== undefined ? { cost_micros: Math.max(0, input.costMicros) } : {}),
      ...(terminal && input.durationMs !== undefined ? { duration_ms: Math.max(0, input.durationMs) } : {}),
    });
  }
  return current;
}

/**
 * Create and start the Runtime read model before any Chat provider I/O.
 * Runtime transitions are trace-only; no worker lease is acquired.
 */
export async function startChatRuntimeTrace(
  db: DatabaseProvider,
  input: StartChatRuntimeTraceInput,
): Promise<ChatRuntimeTrace> {
  let run: RuntimeRunRow | undefined;
  let step: RuntimeStepRow | undefined;
  try {
    const admitted = await db.runtime.admitChatTrace({
      owner_user_id: input.ownerUserId,
      initiated_by_user_id: input.ownerUserId,
      session_id: input.sessionId ?? null,
      source_id: input.sourceId,
      input: chatRuntimePayload(input.input),
      actor_user_id: input.ownerUserId,
    });
    run = admitted.run;
    step = admitted.step;
    if (!['queued', 'claimed', 'running'].includes(run.status)) {
      throw new Error(`Chat Runtime source ${input.sourceId} is already ${run.status}; automatic replay is forbidden`);
    }
    if (!['queued', 'claimed', 'running'].includes(step.status)) {
      throw new Error(
        `Chat Runtime step for ${input.sourceId} is already ${step.status}; automatic replay is forbidden`,
      );
    }
    run = await advanceRun(db, run, 'running', { actorUserId: input.ownerUserId });
    step = await advanceStep(db, step, 'running', { actorUserId: input.ownerUserId });
    return { runId: run.id, stepId: step.id, actorUserId: input.ownerUserId };
  } catch (error) {
    if (run) {
      const trace: ChatRuntimeTrace = {
        runId: run.id,
        stepId: step?.id ?? '',
        actorUserId: input.ownerUserId,
      };
      try {
        await settleChatRuntimeTrace(db, trace, {
          status: 'failed',
          output: { stage: 'runtime_start', error: toErrorMessage(error) },
          errorCode: 'chat_runtime_start_failed',
          errorMessage: toErrorMessage(error),
        });
      } catch (settleError) {
        logger.error('[chat-runtime] failed to close a partially-created trace', {
          runtimeRunId: run.id,
          error: toErrorMessage(settleError),
        });
      }
    }
    throw error;
  }
}

/** Persist the exact provider envelope once model, prompt and tools are known. */
export async function recordChatRuntimeProviderInput(
  db: DatabaseProvider,
  trace: ChatRuntimeTrace,
  input: unknown,
): Promise<void> {
  try {
    await db.runtime.appendEvent({
      run_id: trace.runId,
      step_id: trace.stepId,
      type: 'chat.provider_input',
      payload: chatRuntimePayload(input),
      actor_user_id: trace.actorUserId,
      idempotency_key: 'chat:provider_input',
    });
  } catch (error) {
    try {
      await settleChatRuntimeTrace(db, trace, {
        status: 'failed',
        output: { stage: 'provider_input_persistence', error: toErrorMessage(error) },
        errorCode: 'chat_provider_input_persistence_failed',
        errorMessage: toErrorMessage(error),
      });
    } catch (settleError) {
      logger.error('[chat-runtime] failed to close provider-input admission failure', {
        runtimeRunId: trace.runId,
        error: toErrorMessage(settleError),
      });
    }
    throw error;
  }
}

/** Persist a bounded partial text/reasoning checkpoint during streaming. */
export async function checkpointChatRuntimeStream(
  db: DatabaseProvider,
  trace: ChatRuntimeTrace,
  sequence: number,
  checkpoint: unknown,
): Promise<void> {
  await db.runtime.appendEvent({
    run_id: trace.runId,
    step_id: trace.stepId,
    type: 'chat.stream_checkpoint',
    payload: chatRuntimePayload(checkpoint),
    actor_user_id: trace.actorUserId,
    idempotency_key: `chat:stream_checkpoint:${sequence}`,
  });
}

/**
 * Settle Step first and Run second. If Step settlement fails, Run still gets a
 * terminal attempt so a pre-provider release never silently leaves active work.
 */
export async function settleChatRuntimeTrace(
  db: DatabaseProvider,
  trace: ChatRuntimeTrace,
  input: SettleChatRuntimeTraceInput,
): Promise<void> {
  const output = chatRuntimePayload(input.output);
  let stepError: unknown;
  if (trace.stepId) {
    try {
      const step = await db.runtime.getStep(trace.stepId);
      if (step) {
        await advanceStep(db, step, input.status, {
          actorUserId: trace.actorUserId,
          output,
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          tokensUsed: input.tokensUsed,
          requestsUsed: input.requestsUsed,
          costMicros: input.costMicros,
          durationMs: input.durationMs,
        });
      }
    } catch (error) {
      stepError = error;
    }
  }

  const run = await db.runtime.getRun(trace.runId);
  if (run) {
    await advanceRun(db, run, input.status, {
      actorUserId: trace.actorUserId,
      output,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    });
  }
  if (stepError) throw stepError;
}

/**
 * Boot reconciliation for Chat traces left active by process death.
 *
 * Chat has no replay-safe checkpoint. Every queued/claimed/running trace is
 * therefore permanently interrupted; the Runtime worker must never claim it.
 */
export async function reconcileInterruptedChatRuntimeRuns(db: DatabaseProvider): Promise<number> {
  let cursor: { created_at: string; id: string } | undefined;
  let interrupted = 0;
  do {
    const page = await db.runtime.listRuns({
      kinds: ['chat'],
      statuses: ['queued', 'claimed', 'running'],
      cursor,
      limit: 100,
    });
    for (const run of page.items) {
      if (run.source_kind !== CHAT_SOURCE_KIND || !['queued', 'claimed', 'running'].includes(run.status)) continue;
      const steps = await db.runtime.listSteps(run.id);
      const step = steps.find((candidate) => candidate.step_key === CHAT_STEP_KEY);
      try {
        const [events, toolCalls] = await Promise.all([
          db.runtime.listAllEvents(run.id),
          db.runtime.listToolCalls(run.id),
        ]);
        const checkpointEvent = [...events].reverse().find((event) => event.type === 'chat.stream_checkpoint');
        const reconciledToolCalls: RuntimeToolCallRow[] = [];
        for (const call of toolCalls) {
          if (call.status !== 'running' && call.status !== 'awaiting_approval' && call.status !== 'pending') continue;
          reconciledToolCalls.push(
            await db.runtime.transitionToolCall({
              id: call.id,
              expected_version: call.version,
              to_status: call.status === 'running' ? 'uncertain' : 'canceled',
              event_idempotency_key: `chat:restart:${call.id}:${call.version}`,
              actor_user_id: run.initiated_by_user_id,
              error_code: 'chat_process_restarted',
              error_message: 'The API process restarted before the tool outcome was durably established',
            }),
          );
        }
        const finalToolCalls = toolCalls.map(
          (call) => reconciledToolCalls.find((candidate) => candidate.id === call.id) ?? call,
        );
        const checkpoint = checkpointEvent ? (JSON.parse(checkpointEvent.payload) as { text?: unknown }) : null;
        const committedResults = run.session_id
          ? await Promise.all(
              (['succeeded', 'canceled', 'interrupted'] as const).map(async (status) => ({
                status,
                message: await db.sessions.getMessageById(chatRuntimeResultMessageId(run.id, status)),
              })),
            )
          : [];
        const committed = committedResults.find((candidate) => candidate.message);
        if (committed?.message) {
          await settleChatRuntimeTrace(
            db,
            { runId: run.id, stepId: step?.id ?? '', actorUserId: run.initiated_by_user_id },
            {
              status: committed.status,
              output: {
                reason: 'transcript_committed_before_runtime_terminal',
                recovered_from_transcript: true,
                message_id: committed.message.id,
                content: committed.message.content,
                reasoning: committed.message.reasoning,
                pipeline: JSON.parse(committed.message.pipeline),
                tool_evidence: finalToolCalls.map((call) => ({
                  id: call.id,
                  tool_name: call.tool_name,
                  status: call.status,
                  input: JSON.parse(call.input),
                  output: call.output ? JSON.parse(call.output) : null,
                })),
              },
              tokensUsed:
                Math.max(0, committed.message.input_tokens ?? 0) + Math.max(0, committed.message.output_tokens ?? 0),
              durationMs: committed.message.duration_ms ?? undefined,
            },
          );
          interrupted += committed.status === 'interrupted' ? 1 : 0;
          continue;
        }
        if (run.session_id && checkpoint && typeof checkpoint.text === 'string' && checkpoint.text.trim()) {
          await db.sessions.addMessageOnce(`chat-runtime-restart:${run.id}`, {
            session_id: run.session_id,
            role: 'assistant',
            content: `${checkpoint.text}\n\n[Response interrupted by a service restart.]`,
          });
        }
        await settleChatRuntimeTrace(
          db,
          { runId: run.id, stepId: step?.id ?? '', actorUserId: run.initiated_by_user_id },
          {
            status: 'interrupted',
            output: {
              reason: 'api_process_restart',
              replay_policy: 'never',
              source_kind: run.source_kind,
              source_id: run.source_id,
              last_stream_checkpoint: checkpoint,
              tool_evidence: finalToolCalls.map((call) => ({
                id: call.id,
                tool_name: call.tool_name,
                status: call.status,
                input: JSON.parse(call.input),
                output: call.output ? JSON.parse(call.output) : null,
              })),
            },
            errorCode: 'chat_process_restarted',
            errorMessage: 'The API process restarted before the Chat turn reached a durable terminal state',
          },
        );
        interrupted += 1;
      } catch (error) {
        logger.error('[chat-runtime] boot reconciliation failed', {
          runtimeRunId: run.id,
          error: toErrorMessage(error),
        });
      }
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return interrupted;
}
