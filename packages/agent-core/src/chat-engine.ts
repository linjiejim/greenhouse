/**
 * Chat Engine — the single streaming agent loop for every host
 * (/api/chat NDJSON, evaluation, scheduled tasks, and spawned sessions).
 *
 * Encapsulates: model creation, DSML interceptor, streamText(), tool loop,
 * pipeline/reference collection, usage accounting.
 *
 * Hosts remain thin shells: auth → format parsing → createChatStreamAsync()
 * → format output → persist (persistence stays host-side; the kernel has no
 * database dependency).
 */

import { streamText, stepCountIs, wrapLanguageModel, NoSuchToolError } from 'ai';
import type { StreamTextResult, ToolSet, ModelMessage, ToolCallRepairFunction } from 'ai';
import { createDsmlInterceptor } from './dsml-interceptor.js';
import { repairJsonArguments } from './repair-tool-json.js';
import type { DsmlRecoveryEvent } from './dsml-interceptor.js';
import {
  createModelFromConfig,
  buildProviderOptions,
  applyModelOverride,
  resolveModelConfig,
  resolvesToDeepSeek,
  type ModelConfig,
  type ProviderAttemptHook,
} from './model.js';
import { injectTimeContext, type EngineMessage } from './time-context.js';
import type { PipelineStep, Reference } from '@greenhouse/types/session';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';

// ─── Types ───────────────────────────────────────────────

/**
 * The slice of an agent profile the engine actually consumes. Hosts pass their
 * full profile objects (e.g. the api's YAML AgentProfile) — structural typing
 * keeps the kernel decoupled from host profile schemas.
 */
export interface EngineProfile {
  model: ModelConfig;
  max_steps?: number;
  tool_choice?: 'auto' | 'none' | 'required';
}

export interface ChatEngineInput {
  profile: EngineProfile;
  /**
   * Plain strings for every host except the vision path: user messages may
   * carry multimodal content parts when the catalog marks the model
   * `vision: true` (the api's chat-vision builder is the only producer).
   */
  messages: EngineMessage[];
  tools: Record<string, any>;
  systemPrompt: string;
  sessionId?: string;

  /** Override profile model (e.g. model_override from frontend) */
  modelOverride?: string;
  /** Override profile temperature */
  temperatureOverride?: number;
  /** Override profile max_tokens */
  maxTokensOverride?: number;
  /**
   * External cancellation (server-side stop / graceful shutdown). The SDK
   * surfaces it as an `abort` stream part — same shape as its idle timeout —
   * so hosts handle both through one path.
   */
  abortSignal?: AbortSignal;
  /** Host-owned hard-budget admission at every concrete provider attempt. */
  providerAttemptHook?: ProviderAttemptHook;
}

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

/**
 * Bound every chat turn at the SDK layer, independently from the NDJSON
 * keepalive sent to the browser.
 *
 * `chunkMs` also spans local tool execution in AI SDK v6, so it must stay above
 * the observed 30–100s image-generation window. The total bound prevents a
 * multi-step agent loop from living forever.
 */
export const CHAT_STREAM_TIMEOUT = {
  totalMs: 15 * 60_000,
  stepMs: 4 * 60_000,
  chunkMs: 2 * 60_000,
} as const;

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
 * Create a streaming chat session.
 *
 * Returns the AI SDK StreamTextResult plus metadata for the caller.
 * The caller (route) is responsible for iterating the stream and persisting results.
 */
export async function createChatStreamAsync(input: ChatEngineInput): Promise<{
  streamResult: StreamTextResult<ToolSet, never>;
  dsmlRecoveries: DsmlRecoveryEvent[];
  startTime: number;
  /**
   * Registry id (`flash`, `pro`, …) when the model came from the catalog,
   * otherwise the raw upstream name. Deliberately NOT `modelConfig.model` —
   * that is the *primary* provider's name and does not change when the chain
   * falls through to a backup, so it would claim a provider that never ran.
   */
  modelId: string;
}> {
  const {
    profile,
    messages,
    tools,
    systemPrompt,
    modelOverride,
    temperatureOverride,
    maxTokensOverride,
    abortSignal,
    providerAttemptHook,
  } = input;

  const startTime = Date.now();
  // Apply model override (e.g. fast/slow thinking toggle from frontend).
  // Must go through applyModelOverride — profiles resolve via the registry
  // (`id`), so naively setting `.model` would be silently ignored.
  // resolveModelConfig folds in the catalog's per-model options — the profile
  // no longer carries them, and an override must run on the NEW model's
  // behavior, not the previous one's.
  const modelConfig = resolveModelConfig(
    modelOverride ? applyModelOverride(profile.model, modelOverride) : { ...profile.model },
  );

  // ── Create model ──
  const rawModel = await createModelFromConfig(
    modelConfig,
    providerAttemptHook ? { onProviderAttempt: providerAttemptHook } : {},
  );

  // ── DSML interceptor for DeepSeek models ──
  // Registry-id profiles (the default, e.g. `id: flash`) don't populate
  // `modelConfig.provider`, so the old bare `=== 'deepseek'` check silently
  // skipped interception and leaked raw DSML tool-call markup into the answer.
  // resolvesToDeepSeek() looks through the registry entry to the real model.
  const dsmlRecoveries: DsmlRecoveryEvent[] = [];
  const model = resolvesToDeepSeek(modelConfig)
    ? wrapLanguageModel({
        model: rawModel as Parameters<typeof wrapLanguageModel>[0]['model'],
        middleware: createDsmlInterceptor((event) => {
          dsmlRecoveries.push(event);
          logger.warn('[chat-engine] DSML tool call recovered', {
            sessionId: input.sessionId,
            tools: event.toolCalls.map((t) => t.name),
          });
        }),
      })
    : rawModel;

  // ── Prepare messages with time context ──
  // Cast: only user messages ever carry image parts (chat-vision contract),
  // which is exactly what ModelMessage's per-role content types require.
  const enrichedMessages = injectTimeContext(messages).map((m) => ({
    role: m.role as 'user' | 'assistant' | 'system',
    content: m.content,
  })) as ModelMessage[];

  const providerOptions = buildProviderOptions(modelConfig);
  const maxSteps = profile.max_steps ?? 12;

  // Sampling params: request override wins, then profile YAML options.
  // AI SDK v6 names the output cap `maxOutputTokens` — the old `maxTokens`
  // spread was silently dropped.
  const temperature = temperatureOverride ?? modelConfig.options?.temperature;
  const maxOutputTokens = maxTokensOverride ?? modelConfig.options?.max_tokens;

  const streamResult = streamText({
    model,
    system: systemPrompt,
    messages: enrichedMessages,
    tools,
    experimental_repairToolCall: createToolCallRepair(input.sessionId),
    stopWhen: stepCountIs(maxSteps),
    timeout: CHAT_STREAM_TIMEOUT,
    toolChoice: (profile.tool_choice ?? 'auto') as any,
    prepareStep: ({ stepNumber }: { stepNumber: number }) => {
      if (stepNumber === maxSteps - 1) {
        return { toolChoice: 'none' as const };
      }
      return {};
    },
    ...(providerOptions ? { providerOptions } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(abortSignal ? { abortSignal } : {}),
  });

  return { streamResult, dsmlRecoveries, startTime, modelId: modelConfig.id ?? modelConfig.model };
}

/**
 * Last chance for a tool call whose arguments would not parse.
 *
 * A malformed argument string otherwise discards the whole call, and the model
 * does not reliably recover: on dev, three consecutive `workflow_plan` drafts
 * broke this way and the model abandoned orchestration entirely rather than
 * retrying a fourth time. The repair is local and deterministic (see
 * `repair-tool-json.ts`); a wrong TOOL NAME is not repairable here and is left
 * to fail, since guessing which tool was meant is a different and worse bet.
 *
 * Repairs are logged: a model that needs this often is telling us its tool
 * schema is too big or its description too vague, and that belongs in the
 * friction queue rather than being silently absorbed.
 */
function createToolCallRepair(sessionId?: string): ToolCallRepairFunction<ToolSet> {
  return async ({ toolCall, error }) => {
    if (NoSuchToolError.isInstance(error)) return null;

    const repaired = repairJsonArguments(toolCall.input);
    if (repaired === null || repaired === toolCall.input) {
      logger.warn('[chat-engine] tool call arguments could not be repaired', {
        sessionId,
        tool: toolCall.toolName,
        bytes: toolCall.input?.length,
      });
      return null;
    }

    logger.warn('[chat-engine] repaired malformed tool call arguments', {
      sessionId,
      tool: toolCall.toolName,
      bytes: toolCall.input.length,
    });
    return { ...toolCall, input: repaired };
  };
}

// ─── Final-Answer Guarantee ──────────────────────────────

/**
 * Build a "answer now, no tools" continuation stream.
 *
 * The agent loop occasionally exhausts `max_steps` calling tools without ever
 * emitting an assistant answer (the model keeps searching, or leaks a DSML tool
 * call on the forced final step). Both the streaming and non-stream hosts end
 * up with empty text. When a host detects that (no text produced but tools did
 * run), it calls this to run ONE more generation — the original conversation
 * plus a PLAIN-TEXT digest of the tool results already gathered, tools disabled
 * — so the consumer never gets an empty assistant turn.
 *
 * The gathered evidence is flattened to plain text rather than replayed as
 * structured tool-call/tool-result messages on purpose: replaying that history
 * primes the model to keep calling tools (and leak DSML), which is exactly the
 * loop we're escaping. Thinking is disabled for speed; `toolChoice: 'none'`
 * keeps the DSML interceptor from recovering any residual leak.
 */
interface FinalAnswerInput {
  profile: EngineProfile;
  systemPrompt: string;
  /** The original conversation passed to createChatStreamAsync. */
  baseMessages: EngineMessage[];
  /** The completed primary stream — its gathered tool results are reused. */
  priorResult: StreamTextResult<ToolSet, never>;
  providerAttemptHook?: ProviderAttemptHook;
}

type FinalAnswerStreamFactory = (input: FinalAnswerInput) => Promise<StreamTextResult<ToolSet, never>>;

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
}

/** Extra provider calls are not part of the primary StreamTextResult promises. */
const finalAnswerUsageByPrimary = new WeakMap<object, UsageTotals>();

function emptyUsageTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
}

function addUsage(target: UsageTotals, usage: unknown): void {
  if (!usage || typeof usage !== 'object') return;
  const value = usage as Record<string, unknown>;
  const add = (key: keyof UsageTotals) => {
    const amount = value[key];
    if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) target[key] += amount;
  };
  add('inputTokens');
  add('outputTokens');
  add('cachedInputTokens');
  add('reasoningTokens');
}

/** Flatten the prior turn's tool-result messages into a plain-text evidence digest. */
function digestToolResults(priorTurn: ModelMessage[]): string {
  const MAX_PER_RESULT = 2000;
  const MAX_TOTAL = 16000;
  const blocks: string[] = [];
  for (const m of priorTurn as Array<{ role: string; content: unknown }>) {
    if (m.role !== 'tool' || !Array.isArray(m.content)) continue;
    for (const part of m.content as Array<{ type?: string; toolName?: string; output?: unknown }>) {
      if (part?.type !== 'tool-result') continue;
      const raw = (part.output as { value?: unknown })?.value ?? part.output;
      let text: string;
      try {
        text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      } catch {
        text = String(raw);
      }
      blocks.push(`### ${part.toolName ?? 'tool'}\n${text.slice(0, MAX_PER_RESULT)}`);
    }
  }
  return blocks.join('\n\n').slice(0, MAX_TOTAL);
}

async function createFinalAnswerStreamAsync(input: FinalAnswerInput): Promise<StreamTextResult<ToolSet, never>> {
  const { profile, systemPrompt, baseMessages, priorResult, providerAttemptHook } = input;

  const modelConfig = resolveModelConfig({
    ...profile.model,
    options: { ...profile.model.options, thinking: false },
  });
  const rawModel = await createModelFromConfig(
    modelConfig,
    providerAttemptHook ? { onProviderAttempt: providerAttemptHook } : {},
  );
  const model = resolvesToDeepSeek(modelConfig)
    ? wrapLanguageModel({
        model: rawModel as Parameters<typeof wrapLanguageModel>[0]['model'],
        middleware: createDsmlInterceptor(),
      })
    : rawModel;

  const digest = digestToolResults((await priorResult.response).messages ?? []);
  const messages: ModelMessage[] = [
    ...injectTimeContext(baseMessages).map(
      (m) => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content }) as ModelMessage,
    ),
    {
      role: 'user',
      content:
        `[Information already gathered from the knowledge base:]\n\n${digest || '(no results)'}\n\n` +
        `[Tool use is now disabled. Using only the information above, answer my most recent question in plain text. ` +
        `If the information is insufficient, say so briefly. Do not call any tools.]`,
    },
  ];

  const providerOptions = buildProviderOptions(modelConfig);
  const maxOutputTokens = modelConfig.options?.max_tokens;

  return streamText({
    model,
    system: systemPrompt,
    messages,
    tools: {},
    toolChoice: 'none',
    timeout: CHAT_STREAM_TIMEOUT,
    ...(providerOptions ? { providerOptions } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  });
}

/**
 * One final-answer pass, emitted as synthetic fullStream `text-delta` parts and
 * retried up to `maxAttempts` if a pass yields nothing. A pass can come back
 * empty when the model leaks DSML even here (the interceptor strips it); leaks
 * are intermittent per generation so a retry almost always lands a clean answer.
 * Empty passes yield nothing, so retrying never duplicates content.
 */
async function* finalAnswerParts(
  input: FinalAnswerInput,
  onUsage: (usage: unknown) => void,
  maxAttempts = FINAL_ANSWER_MAX_ATTEMPTS,
  createStream: FinalAnswerStreamFactory = createFinalAnswerStreamAsync,
): AsyncGenerator<{ type: 'text-delta'; text: string }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let produced = '';
    let fallbackStream: StreamTextResult<ToolSet, never> | undefined;
    try {
      fallbackStream = await createStream(input);
      for await (const part of fallbackStream.fullStream) {
        if (part.type === 'text-delta' && part.text) {
          produced += part.text;
          yield { type: 'text-delta', text: part.text };
        }
      }
    } catch (err) {
      logger.warn('[chat-engine] final-answer attempt failed', { attempt, err: String(err) });
    } finally {
      if (fallbackStream) {
        const usage = await Promise.resolve(fallbackStream.totalUsage).catch(() => null);
        onUsage(usage);
      }
    }
    if (produced.trim()) return;
  }
}

export const FINAL_ANSWER_MAX_ATTEMPTS = 3;

/** Whether this model can enter the DeepSeek-only fallback path. */
export function requiresFinalAnswerGuarantee(modelConfig: ModelConfig): boolean {
  return resolvesToDeepSeek(modelConfig);
}

/**
 * Wrap a primary chat stream so it never ends with an empty assistant answer.
 *
 * This is the single host-facing seam for the DeepSeek-only failure mode where
 * the agent loop exhausts its tool budget (or leaks a DSML call on the forced
 * `toolChoice:'none'` final step) and emits no text. Hosts iterate THIS instead
 * of `streamResult.fullStream` — the only line they change. Everything else (the
 * DSML interceptor, the digest, the retry) is quarantined in the kernel and
 * gated on `resolvesToDeepSeek`, so the whole workaround is removable in one
 * place once DeepSeek fixes their parser: delete dsml-interceptor.ts + this
 * section, then revert each host's one-line iteration swap.
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
    yield* finalAnswerParts(
      {
        profile: ctx.profile,
        systemPrompt: ctx.systemPrompt,
        baseMessages: ctx.baseMessages,
        priorResult: streamResult,
        ...(ctx.providerAttemptHook ? { providerAttemptHook: ctx.providerAttemptHook } : {}),
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
