/**
 * Chat Engine — the STREAMING host of the shared agent loop (agent-loop.ts):
 * /api/chat NDJSON and the Bots engine. Headless hosts (scheduled tasks,
 * spawn_session, workflow nodes, the Feishu bot) run the very same assembly
 * through runAgentLoop() instead.
 *
 * What lives here is only what streaming needs on top of the loop: the
 * final-answer guarantee spliced into the live stream, the stream collectors
 * and usage accounting for persistence.
 *
 * Hosts remain thin shells: auth → format parsing → createChatStreamAsync()
 * → format output → persist (persistence stays host-side; the kernel has no
 * database dependency).
 */

import { streamText } from 'ai';
import type { StreamTextResult, ToolSet } from 'ai';
import type { DsmlRecoveryEvent } from './dsml-interceptor.js';
import { resolvesToDeepSeek, type ProviderAttemptHook } from './model.js';
import { prepareAgentLoop, type AgentLoopInput, type EngineProfile } from './agent-loop.js';
import {
  addUsage,
  emptyUsageTotals,
  finalAnswerParts,
  FINAL_ANSWER_MAX_ATTEMPTS,
  requiresFinalAnswerGuarantee,
  type FinalAnswerStreamFactory,
  type UsageTotals,
} from './final-answer.js';
import type { TimeContextOption } from './loop-shared.js';
import type { EngineMessage } from './time-context.js';
import type { PipelineStep, Reference } from '@greenhouse/types/session';
import { toErrorMessage } from '@greenhouse/utils/error';

export { CHAT_STREAM_TIMEOUT } from './loop-shared.js';
export { FINAL_ANSWER_MAX_ATTEMPTS, requiresFinalAnswerGuarantee };
export type { EngineProfile };

// ─── Types ───────────────────────────────────────────────

/** The streaming host takes exactly the shared loop input. */
export type ChatEngineInput = AgentLoopInput;

export interface ChatEngineResult {
  text: string;
  reasoningText?: string;
  finishReason?: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other';
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  };
  pipelineSteps: PipelineStep[];
  references: Reference[];
  durationMs: number;
  dsmlRecoveries: DsmlRecoveryEvent[];
}

// ─── Summarize Output ────────────────────────────────────

/**
 * Produce a compact summary of tool output for pipeline storage.
 * Uses actual registered tool names (knowledge_query, analyze_image, etc.)
 */
export function summarizeOutput(toolName: string, output: Record<string, unknown>): unknown {
  switch (toolName) {
    // knowledge_query has no `action` field in its output, so it is summarized
    // by shape. Without a case it fell to `default: return output`, which
    // stored every document body it read in messages.pipeline — cheap to miss
    // while it was one of three KB tools, expensive now that it is the only one.
    case 'knowledge_query':
      if (output.error) return { error: output.error };
      if (Array.isArray(output.folders)) {
        return { action: 'tree', scope: output.scope, root: output.root, docs: output.total_docs };
      }
      if (Array.isArray(output.versions)) {
        return { action: 'versions', doc_id: output.doc_id, found: output.found };
      }
      if (Array.isArray(output.results)) {
        return {
          action: 'search',
          scope: output.scope,
          found: output.found,
          ...(output.weak_match ? { weak_match: true } : {}),
        };
      }
      return {
        action: 'get',
        scope: output.scope,
        doc_id: output.doc_id ?? output.source_id,
        title: output.title,
        chars: ((output.content as string) ?? '').length,
        ...(output.mode ? { mode: output.mode } : {}),
      };
    case 'analyze_image':
      return output.error
        ? { error: output.error }
        : {
            image_id: output.image_id,
            description: ((output.description as string) ?? '').slice(0, 200) + '...',
            model: output.model,
            duration_ms: output.duration_ms,
          };
    default:
      return output;
  }
}

// ─── Chat Stream ─────────────────────────────────────────

/**
 * Create a streaming chat session on the shared loop assembly.
 *
 * Returns the AI SDK StreamTextResult plus metadata for the caller.
 * The caller (route) is responsible for iterating the stream and persisting results.
 */
export async function createChatStreamAsync(input: ChatEngineInput): Promise<{
  streamResult: StreamTextResult<ToolSet, never>;
  dsmlRecoveries: DsmlRecoveryEvent[];
  startTime: number;
  /** Registry id when the model came from the catalog — see PreparedAgentLoop.modelId. */
  modelId: string;
}> {
  const prepared = await prepareAgentLoop(input);
  const streamResult = streamText(prepared.settings);
  return {
    streamResult,
    dsmlRecoveries: prepared.dsmlRecoveries,
    startTime: prepared.startTime,
    modelId: prepared.modelId,
  };
}

// ─── Final-Answer Guarantee (streaming) ──────────────────

/** Extra provider calls are not part of the primary StreamTextResult promises. */
const finalAnswerUsageByPrimary = new WeakMap<object, UsageTotals>();

/**
 * Wrap a primary chat stream so it never ends with an empty assistant answer.
 *
 * This is the streaming host's seam for the DeepSeek-only failure mode where
 * the agent loop exhausts its tool budget (or leaks a DSML call on the forced
 * `toolChoice:'none'` final step) and emits no text (see final-answer.ts).
 * Hosts iterate THIS instead of `streamResult.fullStream` — the only line they
 * change.
 *
 * Mechanics: pass every part through untouched but hold back the terminal
 * `finish` part; if the loop produced no text yet ran tools, splice in the
 * final-answer parts (as ordinary `text-delta`s, so host switches/collectors
 * need no special-casing) before finally emitting `finish`.
 */
export async function* withFinalAnswerGuarantee(
  streamResult: StreamTextResult<ToolSet, never>,
  ctx: {
    profile: EngineProfile;
    systemPrompt: string;
    baseMessages: EngineMessage[];
    providerAttemptHook?: ProviderAttemptHook;
    /** Same time-context choice as the primary loop. */
    timeContext?: TimeContextOption;
    /** Deterministic provider seam for the fallback accounting test. */
    finalAnswerStreamFactory?: FinalAnswerStreamFactory;
  },
): AsyncGenerator<any> {
  // Only DeepSeek leaks DSML / loops to an empty answer; everything else streams
  // through untouched (and the workaround stays trivially removable).
  if (!resolvesToDeepSeek(ctx.profile.model)) {
    yield* streamResult.fullStream as AsyncIterable<any>;
    return;
  }

  let sawText = false;
  let toolRan = false;
  let sawAbort = false;
  let finishPart: any = null;

  for await (const part of streamResult.fullStream as AsyncIterable<any>) {
    if (part.type === 'text-delta' && part.text) sawText = true;
    else if (part.type === 'tool-result') toolRan = true;
    else if (part.type === 'abort') sawAbort = true;
    if (part.type === 'finish') {
      finishPart = part; // defer until after any spliced-in answer
      continue;
    }
    yield part;
  }

  // An aborted turn (user stop / timeout / shutdown) must not trigger extra
  // LLM calls — the "no answer" here is intentional, not a DeepSeek leak.
  if (!sawText && toolRan && !sawAbort) {
    const extraUsage = emptyUsageTotals();
    finalAnswerUsageByPrimary.set(streamResult, extraUsage);
    const gatheredMessages = (await Promise.resolve(streamResult.response).catch(() => null))?.messages ?? [];
    yield* finalAnswerParts(
      {
        profile: ctx.profile,
        systemPrompt: ctx.systemPrompt,
        baseMessages: ctx.baseMessages,
        gatheredMessages,
        ...(ctx.providerAttemptHook ? { providerAttemptHook: ctx.providerAttemptHook } : {}),
        ...(ctx.timeContext !== undefined ? { timeContext: ctx.timeContext } : {}),
      },
      (usage) => addUsage(extraUsage, usage),
      FINAL_ANSWER_MAX_ATTEMPTS,
      ctx.finalAnswerStreamFactory,
    );
  }
  if (finishPart) yield finishPart;
}

// ─── Collectors ──────────────────────────────────────────

/**
 * State collectors for streaming loop metadata.
 * Both routes use these to gather pipeline steps, references, etc.
 */
export interface StreamCollectors {
  fullText: string;
  reasoningText: string;
  pipelineSteps: PipelineStep[];
  referencesMap: Map<string, Reference>;
  searchRelevance: Map<string, number>;
  stepStartTime: number;
  activeToolInputs: Map<string, { name: string; input: string }>;
  receivedFinish: boolean;
  streamError?: string;
  streamCompleted: boolean;
}

export function createCollectors(): StreamCollectors {
  return {
    fullText: '',
    reasoningText: '',
    pipelineSteps: [],
    referencesMap: new Map(),
    searchRelevance: new Map(),
    stepStartTime: Date.now(),
    activeToolInputs: new Map(),
    receivedFinish: false,
    streamError: undefined,
    streamCompleted: false,
  };
}

/**
 * Process a stream event part and update collectors.
 * Called by the streaming loop in each route to collect metadata.
 */
export function processStreamPart(part: any, collectors: StreamCollectors): void {
  switch (part.type) {
    case 'text-delta':
      collectors.fullText += part.text;
      break;

    case 'reasoning-delta':
      collectors.reasoningText += part.text;
      break;

    case 'tool-input-start':
      collectors.activeToolInputs.set(part.id, { name: part.toolName, input: '' });
      break;

    case 'tool-input-delta': {
      const tc = collectors.activeToolInputs.get(part.id);
      if (tc) tc.input += part.delta;
      break;
    }

    case 'tool-result': {
      const toolOutput = part.output as Record<string, unknown>;

      // Collect pipeline step
      const tcInfo = collectors.activeToolInputs.get(part.toolCallId);
      const stepDuration = Date.now() - collectors.stepStartTime;
      let parsedInput: unknown = null;
      if (tcInfo) {
        try {
          parsedInput = JSON.parse(tcInfo.input);
        } catch {
          parsedInput = tcInfo.input;
        }
      }
      collectors.pipelineSteps.push({
        // Unique, monotonic index per tool call. Keying off the LLM round counter
        // meant parallel tool calls in one round shared a number (1,2,3,4,4,…).
        step: collectors.pipelineSteps.length + 1,
        tool: part.toolName,
        input: parsedInput,
        output: summarizeOutput(part.toolName, toolOutput),
        duration_ms: stepDuration,
      });

      // Track knowledge search relevance scores
      if (part.toolName === 'knowledge_query' && Array.isArray(toolOutput.results)) {
        for (const result of toolOutput.results as Array<{ doc_id?: string; id?: number; relevance?: number }>) {
          const key = result.doc_id ?? (result.id != null ? String(result.id) : '');
          if (key && result.relevance != null) {
            collectors.searchRelevance.set(key, result.relevance);
          }
        }
      }

      // Collect references from knowledge documents actually read
      if (
        part.toolName === 'knowledge_query' &&
        typeof toolOutput.doc_id === 'string' &&
        typeof toolOutput.title === 'string' &&
        !toolOutput.error
      ) {
        const slug = toolOutput.doc_id as string;
        if (slug) {
          collectors.referencesMap.set(slug, {
            slug,
            title: (toolOutput.title as string) ?? '',
            type: 'kb_doc',
            category: (toolOutput.folder as string) ?? undefined,
            relevance: collectors.searchRelevance.get(slug),
          });
        }
      }

      collectors.activeToolInputs.delete(part.toolCallId);
      break;
    }

    case 'start-step':
      collectors.stepStartTime = Date.now();
      break;

    case 'finish':
      collectors.receivedFinish = true;
      break;

    case 'error':
      collectors.streamError = toErrorMessage(part.error);
      break;

    case 'abort':
      collectors.streamError = 'Chat generation aborted before completion';
      break;

    default:
      break;
  }
}

/**
 * Build a ChatEngineResult from collectors and SDK result promises.
 * Call after streaming is complete (or interrupted) to get the final result for persistence.
 */
export async function buildEngineResult(
  streamResult: StreamTextResult<ToolSet, never>,
  collectors: StreamCollectors,
  dsmlRecoveries: DsmlRecoveryEvent[],
  startTime: number,
): Promise<ChatEngineResult> {
  const [finalText, finalUsage, finalReasoningText, finishReason] = await Promise.all([
    Promise.resolve(streamResult.text).catch(() => ''),
    Promise.resolve(streamResult.totalUsage).catch(() => null),
    Promise.resolve(streamResult.reasoningText).catch(() => undefined),
    Promise.resolve(streamResult.finishReason).catch(() => undefined),
  ]);

  const durationMs = Date.now() - startTime;
  const textToUse = finalText || collectors.fullText;
  const usage = finalUsage as any;
  const finalAnswerUsage = finalAnswerUsageByPrimary.get(streamResult) ?? emptyUsageTotals();

  return {
    text: textToUse,
    reasoningText: collectors.reasoningText || (finalReasoningText as string) || undefined,
    finishReason,
    usage: {
      inputTokens: (usage?.inputTokens ?? 0) + finalAnswerUsage.inputTokens,
      outputTokens: (usage?.outputTokens ?? 0) + finalAnswerUsage.outputTokens,
      cachedInputTokens: (usage?.cachedInputTokens ?? 0) + finalAnswerUsage.cachedInputTokens,
      reasoningTokens: (usage?.reasoningTokens ?? 0) + finalAnswerUsage.reasoningTokens,
    },
    pipelineSteps: collectors.pipelineSteps,
    references: [...collectors.referencesMap.values()],
    durationMs,
    dsmlRecoveries,
  };
}
