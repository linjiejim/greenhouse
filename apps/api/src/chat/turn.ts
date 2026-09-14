/**
 * Chat turn execution — the detached agent loop behind /api/chat, and the
 * subscription layer that pipes a run into any number of NDJSON responses.
 *
 * A turn's lifetime belongs to its ChatRun (chat-runs.ts), not to the HTTP
 * request that started it: the route hands the loop off here and then becomes
 * just the run's first subscriber, so a client disconnect/refresh never
 * orphans a generation. Lives beside chat-persist.ts (its terminal step) and
 * keeps routes/chat.ts at protocol-adapter altitude.
 */

import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { getDb } from '@greenhouse/db';
import { withFinalAnswerGuarantee, processStreamPart, buildEngineResult } from '@greenhouse/agent-core';
import type {
  ChatEngineResult,
  StreamCollectors,
  DsmlRecoveryEvent,
  EngineMessage,
  ProviderAttemptHook,
} from '@greenhouse/agent-core';
import type { StreamTextResult, ToolSet } from 'ai';
import type { ClientActionBridge } from '../tools/client-action-bridge.js';
import type { AgentProfile } from '../profiles/profile.js';
import { persistChatResult } from './persist.js';
import { chatRunRegistry, type ChatRun } from './runs.js';
import { UsageBudgetAdmissionError } from '../llm/usage-budget.js';
import { connectionManager } from '../ws/connection-manager.js';
import {
  chatRuntimePayload,
  chatRuntimeResultMessageId,
  checkpointChatRuntimeStream,
  settleChatRuntimeTrace,
  type ChatRuntimeTerminalStatus,
  type ChatRuntimeTrace,
} from './runtime.js';

/**
 * How often to write a keepalive `ping` while a turn is in flight.
 *
 * Sized against the tightest idle timeout in the path — nginx's `proxy_read_timeout`
 * default of 60s — with room for a couple of dropped intervals. Cheap enough to run
 * for every turn rather than trying to predict which tools will be slow.
 * Written per-connection (not buffered in the run): a replayed ping is noise.
 */
const STREAM_KEEPALIVE_MS = 15_000;
const RUNTIME_CHECKPOINT_INTERVAL_MS = 1_000;

// ─── Response Subscription ───────────────────────────────

/** The slice of Hono's StreamingApi the subscription layer needs. */
export interface NdjsonStream {
  write(chunk: string): Promise<unknown>;
  onAbort(cb: () => void): void;
}

/**
 * Pipe a run into one NDJSON response: replay events with seq > afterSeq, then
 * follow live until the run ends (which happens only after persistence, so a
 * client that sees this response close can immediately refetch messages
 * without racing the DB write). A dead client just unsubscribes — the run
 * itself keeps going.
 */
export async function streamRunToResponse(run: ChatRun, stream: NdjsonStream, afterSeq: number): Promise<void> {
  // Serialize writes so replay, live events and pings can't interleave lines.
  let writeChain: Promise<unknown> = Promise.resolve();
  const safeWrite = (obj: Record<string, unknown>): void => {
    writeChain = writeChain.then(() => stream.write(JSON.stringify(obj) + '\n')).catch(() => {});
  };

  const keepalive = setInterval(() => safeWrite({ type: 'ping' }), STREAM_KEEPALIVE_MS);
  try {
    await new Promise<void>((resolve) => {
      const unsubscribe = run.subscribe(afterSeq, {
        onEvent: (event) => safeWrite(event),
        onEnd: () => resolve(),
      });
      stream.onAbort(() => {
        unsubscribe();
        resolve();
      });
    });
    await writeChain; // flush queued writes before the response closes
  } finally {
    clearInterval(keepalive);
  }
}

// ─── Detached Agent Turn ─────────────────────────────────

export interface ChatTurnArgs {
  run: ChatRun;
  streamResult: StreamTextResult<ToolSet, never>;
  collectors: StreamCollectors;
  dsmlRecoveries: DsmlRecoveryEvent[];
  startTime: number;
  modelId: string;
  profile: AgentProfile;
  systemPrompt: string;
  chatMessages: EngineMessage[];
  sessionId?: string;
  userId: string;
  userLocale?: string;
  titlePromise: Promise<string> | null;
  clientActionBridge: ClientActionBridge | null;
  replaceAssistantMessageId?: string;
  expectedTail?: {
    id: string;
    content: string;
  };
  /** Reused by the DeepSeek final-answer continuation, if one is needed. */
  providerAttemptHook: ProviderAttemptHook;
  /** Durable trace for every authenticated ordinary Chat provider turn. */
  runtimeTrace: ChatRuntimeTrace | null;
}

/**
 * Pump the agent loop to completion and persist the result. Runs detached from
 * any HTTP response — its lifetime is the run's, not a connection's. Always
 * ends the run (success or failure) so subscribers never hang.
 */
export async function pumpChatTurn(args: ChatTurnArgs): Promise<void> {
  const {
    run,
    streamResult,
    collectors,
    dsmlRecoveries,
    startTime,
    modelId,
    profile,
    systemPrompt,
    chatMessages,
    sessionId,
    userId,
    userLocale,
    titlePromise,
    clientActionBridge,
    replaceAssistantMessageId,
    expectedTail,
    providerAttemptHook,
    runtimeTrace,
  } = args;

  // Pipeline summaries intentionally stay compact for the transcript UI. The
  // Runtime trace separately retains every parsed tool input/output verbatim.
  const rawToolEvidence: Array<Record<string, unknown>> = [];
  let checkpointSequence = 0;
  let lastCheckpointAt = 0;
  let checkpointChain: Promise<void> = Promise.resolve();
  const persistCheckpoint = (force = false) => {
    if (!runtimeTrace) return;
    const now = Date.now();
    if (!force && now - lastCheckpointAt < RUNTIME_CHECKPOINT_INTERVAL_MS) return;
    lastCheckpointAt = now;
    const sequence = checkpointSequence++;
    const snapshot = {
      text: collectors.fullText,
      reasoning: collectors.reasoningText,
      recorded_at: new Date(now).toISOString(),
    };
    checkpointChain = checkpointChain
      .then(() => checkpointChatRuntimeStream(getDb(), runtimeTrace, sequence, snapshot))
      .catch((error) => logger.error('[chat-runtime] stream checkpoint failed', error));
  };

  // Client-action requests are emitted by the bridge from inside a tool's
  // execute(); routing them through the run reaches every attached client.
  if (clientActionBridge) {
    clientActionBridge.setWriter(async (event) => run.emit(event));
  }

  if (run.sessionId) {
    connectionManager.sendToUser(userId, {
      type: 'chat:run',
      sessionId: run.sessionId,
      runId: run.runId,
      status: 'running',
    });
  }

  let titleSent = false;
  let resolvedTitle: string | null = null;
  if (titlePromise) {
    titlePromise
      .then((title) => {
        resolvedTitle = title;
      })
      .catch(() => {});
  }

  // Set once a budget admission refusal is seen, so every notice site (stream
  // error event, abort event, persisted transcript) tells the same true story.
  let admissionNotice: string | undefined;
  const noteAdmissionRefusal = (err: unknown): void => {
    admissionNotice ||= usageBudgetNotice(err, userLocale) ?? undefined;
  };

  const interruptionText = () =>
    run.stopReason === 'user' ? chatStopNotice(userLocale) : (admissionNotice ?? chatInterruptionNotice(userLocale));

  try {
    // withFinalAnswerGuarantee == streamResult.fullStream, except it splices
    // in a final answer (and reorders `finish` after it) when a DeepSeek run
    // ends with no text. Swap back to streamResult.fullStream to remove.
    for await (const part of withFinalAnswerGuarantee(streamResult, {
      profile,
      systemPrompt,
      baseMessages: chatMessages,
      providerAttemptHook,
    })) {
      // Inject the generated title as soon as it is available
      if (resolvedTitle && !titleSent) {
        titleSent = true;
        run.emit({ type: 'title', title: resolvedTitle });
      }

      // Update collectors
      processStreamPart(part, collectors);
      if (part.type === 'text-delta' || part.type === 'reasoning-delta') persistCheckpoint();

      // Emit NDJSON events (internal format — unchanged for Web/CLI)
      let event: Record<string, unknown> | null = null;

      switch (part.type) {
        case 'text-delta':
          event = { type: 'text-delta', text: part.text };
          break;

        case 'reasoning-delta':
          event = { type: 'reasoning-delta', text: part.text };
          break;

        case 'tool-input-start':
          event = { type: 'tool-call-start', id: part.id, toolName: part.toolName };
          break;

        case 'tool-input-delta':
          event = { type: 'tool-call-delta', id: part.id, delta: part.delta };
          break;

        case 'tool-input-end':
          event = { type: 'tool-call-end', id: part.id };
          break;

        case 'tool-call':
          rawToolEvidence.push({
            type: 'tool-call',
            id: part.toolCallId,
            tool_name: part.toolName,
            input: part.input,
          });
          event = { type: 'tool-call', id: part.toolCallId, toolName: part.toolName, input: part.input };
          break;

        case 'tool-result':
          rawToolEvidence.push({
            type: 'tool-result',
            id: part.toolCallId,
            tool_name: part.toolName,
            output: part.output,
          });
          event = {
            type: 'tool-result',
            id: part.toolCallId,
            toolName: part.toolName,
            output: part.output as Record<string, unknown>,
          };
          break;

        case 'start-step':
          event = { type: 'step-start' };
          break;

        case 'finish-step':
          event = { type: 'step-finish', finishReason: part.finishReason, usage: part.usage };
          break;

        case 'finish':
          event = { type: 'finish', finishReason: part.finishReason, usage: part.totalUsage };
          break;

        case 'error':
          noteAdmissionRefusal(part.error);
          event = { type: 'error', error: interruptionText() };
          break;

        case 'abort':
          event = { type: 'error', error: interruptionText() };
          break;

        default:
          break;
      }

      if (event) {
        run.emit(event);
      }
    }

    collectors.streamCompleted = collectors.receivedFinish && !collectors.streamError;

    // Emit title event if not yet sent (title gen finished after stream loop)
    if (!titleSent && titlePromise) {
      try {
        const title = await titlePromise;
        run.emit({ type: 'title', title });
      } catch {
        /* fallback already handled in promise */
      }
    }
  } catch (err: any) {
    collectors.streamError ||= toErrorMessage(err);
    noteAdmissionRefusal(err);
    if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      logger.info('[chat] stream interrupted:', err?.message || err);
    }
  }

  persistCheckpoint(true);
  await checkpointChain;

  // ── Persist (session mode), settle Runtime, then end the wire run ──
  let runStatus: 'completed' | 'error';
  let engineResult: ChatEngineResult | undefined;
  let generationCompleted = false;
  let interruptionReason: string | undefined;
  let persistenceError: string | undefined;
  try {
    engineResult = await buildEngineResult(streamResult, collectors, dsmlRecoveries, startTime);
    generationCompleted =
      engineResult.finishReason !== undefined && engineResult.finishReason !== 'error' && !collectors.streamError;
    interruptionReason = generationCompleted
      ? undefined
      : collectors.streamError || 'Chat stream ended without a successful finish event';
    runStatus = generationCompleted ? 'completed' : 'error';

    if (sessionId && interruptionReason) {
      logger.warn('[chat] persisting interrupted response', {
        sessionId,
        finishReason: engineResult.finishReason,
        error: interruptionReason,
      });
    }

    // Fallback: if stream was interrupted and collectors have nothing, try SDK steps.
    // Runtime keeps the raw values separately even though transcript pipeline
    // projections intentionally summarize selected tool outputs.
    if (engineResult.pipelineSteps.length === 0 && !collectors.streamCompleted) {
      try {
        const steps = await streamResult.steps;
        for (const step of steps) {
          if (step.toolCalls) {
            for (const tc of step.toolCalls as unknown as Array<{
              toolCallId: string;
              toolName: string;
              input: unknown;
            }>) {
              engineResult.pipelineSteps.push({
                step: engineResult.pipelineSteps.length,
                tool: tc.toolName,
                input: tc.input,
                output: null,
                duration_ms: 0,
              });
              rawToolEvidence.push({
                type: 'tool-call',
                id: tc.toolCallId,
                tool_name: tc.toolName,
                input: tc.input,
                recovered_from_sdk_steps: true,
              });
            }
          }
          if (step.toolResults) {
            for (const tr of step.toolResults as unknown as Array<{
              toolCallId: string;
              toolName: string;
              output: Record<string, unknown>;
            }>) {
              rawToolEvidence.push({
                type: 'tool-result',
                id: tr.toolCallId,
                tool_name: tr.toolName,
                output: tr.output,
                recovered_from_sdk_steps: true,
              });
              if (
                tr.toolName === 'knowledge_query' &&
                tr.output &&
                typeof (tr.output as any).doc_id === 'string' &&
                typeof (tr.output as any).title === 'string' &&
                !(tr.output as any).error
              ) {
                const out = tr.output;
                if (out.doc_id) {
                  engineResult.references.push({
                    slug: out.doc_id as string,
                    title: (out.title as string) ?? '',
                    type: 'kb_doc',
                    category: (out.folder as string) ?? undefined,
                    source_id: (out.source_id as string) ?? undefined,
                  });
                }
              }
            }
          }
        }
      } catch {
        /* steps promise failed */
      }
    }

    if (sessionId) {
      const persistedStatus: ChatRuntimeTerminalStatus =
        run.stopReason === 'user'
          ? 'canceled'
          : run.stopReason === 'shutdown'
            ? 'interrupted'
            : generationCompleted
              ? 'succeeded'
              : 'interrupted';
      await persistChatResult({
        sessionId,
        caller: 'chat',
        modelId,
        engineResult,
        dsmlRecoveries,
        streamCompleted: generationCompleted,
        interruptionReason,
        interruptionNotice: interruptionText(),
        replaceAssistantMessageId,
        expectedTail,
        ...(runtimeTrace ? { resultMessageId: chatRuntimeResultMessageId(runtimeTrace.runId, persistedStatus) } : {}),
      });
    }
  } catch (err) {
    persistenceError = toErrorMessage(err);
    runStatus = 'error';
    logger.error('[chat] background save failed:', err);
  }

  if (runtimeTrace) {
    const runtimeStatus: ChatRuntimeTerminalStatus =
      run.stopReason === 'user'
        ? 'canceled'
        : run.stopReason === 'shutdown'
          ? 'interrupted'
          : persistenceError
            ? 'failed'
            : generationCompleted
              ? 'succeeded'
              : 'interrupted';
    const errorCode =
      runtimeStatus === 'canceled'
        ? 'chat_user_canceled'
        : runtimeStatus === 'interrupted'
          ? run.stopReason === 'shutdown'
            ? 'chat_process_shutdown'
            : 'chat_stream_interrupted'
          : runtimeStatus === 'failed'
            ? 'chat_persistence_failed'
            : undefined;
    const errorMessage =
      runtimeStatus === 'canceled'
        ? 'The user stopped Chat generation'
        : (persistenceError ?? interruptionReason ?? undefined);
    const tokensUsed = engineResult
      ? Math.max(0, engineResult.usage.inputTokens) + Math.max(0, engineResult.usage.outputTokens)
      : undefined;
    try {
      const runtimeOutput = chatRuntimePayload({
        model_id: modelId,
        engine_result: engineResult ?? null,
        raw_tool_evidence: rawToolEvidence,
        stream: {
          received_finish: collectors.receivedFinish,
          completed: collectors.streamCompleted,
          error: collectors.streamError ?? null,
        },
        persistence: {
          session_id: sessionId ?? null,
          persisted: Boolean(sessionId) && !persistenceError,
          replace_assistant_message_id: replaceAssistantMessageId ?? null,
          expected_tail: expectedTail ?? null,
          error: persistenceError ?? null,
        },
        generated_title: resolvedTitle,
      });
      await settleChatRuntimeTrace(getDb(), runtimeTrace, {
        status: runtimeStatus,
        output: runtimeOutput,
        ...(errorCode ? { errorCode } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        ...(tokensUsed !== undefined ? { tokensUsed } : {}),
        ...(engineResult ? { durationMs: engineResult.durationMs } : {}),
      });
    } catch (err) {
      logger.error('[chat-runtime] terminal settlement failed:', err);
      try {
        await settleChatRuntimeTrace(getDb(), runtimeTrace, {
          status: 'failed',
          output: { stage: 'runtime_terminal_evidence', error: toErrorMessage(err) },
          errorCode: 'chat_runtime_terminalization_failed',
          errorMessage: toErrorMessage(err),
        });
      } catch (fallbackError) {
        logger.error('[chat-runtime] fallback terminal settlement failed:', fallbackError);
      }
    }
  }

  chatRunRegistry.finish(run, runStatus);
  if (run.sessionId) {
    connectionManager.sendToUser(userId, {
      type: 'chat:run',
      sessionId: run.sessionId,
      runId: run.runId,
      status: runStatus,
    });
  }
}

// ─── Interruption Notices ────────────────────────────────

export function chatInterruptionNotice(locale?: string): string {
  return locale === 'en'
    ? 'The response was interrupted before completion. Please retry.'
    : '回答生成在完成前中断，未完成的内容已舍弃，请重试。';
}

export function chatStopNotice(locale?: string): string {
  return locale === 'en' ? 'Generation stopped at your request.' : '已按要求停止生成。';
}

/**
 * Budget admission is the one failure whose real message must reach the user.
 *
 * Every other stream failure collapses to the generic notice on purpose: a raw
 * provider error is unactionable and a disclosure risk. This one is different
 * on all three counts — the text is ours and written for the user, the refusal
 * happens before any provider I/O (so nothing was charged and nothing is
 * secret), and "please retry" is actively false: every retry is refused the
 * same way in about a second, which is exactly what a user does when told to
 * retry. Returns null for anything else, keeping the generic notice.
 */
export function usageBudgetNotice(err: unknown, locale?: string): string | null {
  // The AI SDK wraps provider-attempt failures (e.g. in RetryError) before they
  // reach fullStream, so match on the cause chain rather than the top value.
  let admission: UsageBudgetAdmissionError | null = null;
  let cursor: unknown = err;
  for (let depth = 0; cursor && depth < 4; depth++) {
    if (cursor instanceof UsageBudgetAdmissionError) {
      admission = cursor;
      break;
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  if (!admission) return null;

  const en = locale === 'en';
  if (admission.status === 429) {
    return en
      ? "This month's token budget is used up, so retrying will not help. Ask an administrator to raise the monthly limit."
      : '本月 Token 额度已用尽，重试不会成功。请联系管理员提高月度额度。';
  }
  if (admission.status === 403) {
    return en
      ? 'This account is not allowed to make model calls right now. Contact an administrator.'
      : '当前账号暂时无法发起模型调用，请联系管理员。';
  }
  return en
    ? 'The usage budget service is temporarily unavailable. Please try again shortly.'
    : '用量额度服务暂时不可用，请稍后再试。';
}
