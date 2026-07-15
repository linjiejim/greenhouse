/**
 * Chat Engine — the single streaming agent loop for every host
 * (/api/chat NDJSON, /api/v1 OpenAI-compatible SSE, eval, scheduler).
 *
 * Encapsulates: model creation, streamText(), tool loop, pipeline/reference
 * collection, usage accounting.
 *
 * Hosts remain thin shells: auth → format parsing → createChatStreamAsync()
 * → format output → persist (persistence stays host-side; the kernel has no
 * database dependency).
 */

import { streamText, stepCountIs, wrapLanguageModel } from 'ai';
import type { StreamTextResult, ToolSet, ModelMessage } from 'ai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { logger } from '@greenhouse/utils/logger';
import { createModelFromConfig, buildProviderOptions, applyModelOverride, type ModelConfig } from './model.js';
import { getProviderMiddleware } from './provider-extensions.js';
import { getToolOutputSummarizer } from './tool-stream-hooks.js';
import { injectTimeContext } from './time-context.js';
import { isLocalToolMarker } from './local-tool-marker.js';
import type { PipelineStep, Reference } from '@greenhouse/types/session';

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
  messages: Array<{ role: string; content: string; created_at?: string }>;
  tools: Record<string, any>;
  systemPrompt: string;
  sessionId?: string;

  /** Override profile model (e.g. model_override from frontend) */
  modelOverride?: string;
  /** Override profile temperature */
  temperatureOverride?: number;
  /** Override profile max_tokens */
  maxTokensOverride?: number;
}

export interface ChatEngineResult {
  text: string;
  reasoningText?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  };
  pipelineSteps: PipelineStep[];
  references: Reference[];
  durationMs: number;
}

// ─── Summarize Output ────────────────────────────────────

/**
 * Produce a compact summary of tool output for pipeline storage.
 * Uses actual registered tool names (knowledge_query, etc.)
 */
export function summarizeOutput(toolName: string, output: Record<string, unknown>): unknown {
  // Fork-registered summarizers take precedence — see tool-stream-hooks.ts (empty
  // upstream, so the core cases below apply unchanged).
  const custom = getToolOutputSummarizer(toolName);
  if (custom) return custom(output);

  switch (toolName) {
    case 'knowledge_query':
      if (output.action === 'search') {
        return { action: 'search', found: output.found, query: output.query };
      }
      return output.error
        ? { action: 'get', error: output.error }
        : {
            action: 'get',
            doc_id: output.doc_id ?? output.slug,
            title: output.title,
            chars: ((output.content as string) ?? '').length,
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
  startTime: number;
  modelId: string;
}> {
  const { profile, messages, tools, systemPrompt, modelOverride, temperatureOverride, maxTokensOverride } = input;

  const startTime = Date.now();
  // Apply model override (e.g. fast/slow thinking toggle from frontend).
  // Must go through applyModelOverride — profiles resolve via the registry
  // (`id`), so naively setting `.model` would be silently ignored.
  const modelConfig = modelOverride ? applyModelOverride(profile.model, modelOverride) : { ...profile.model };

  // ── Create model ──
  // A fork may register per-provider middleware (e.g. a DeepSeek/DSML interceptor)
  // via registerProviderMiddleware() — see provider-extensions.ts (empty upstream).
  // createModelFromConfig always yields a LanguageModelV3 at runtime (direct or
  // fallback wrapper); the cast bridges the SDK's broad LanguageModel union.
  const rawModel = await createModelFromConfig(modelConfig);
  const middleware = getProviderMiddleware(modelConfig.provider);
  const model = middleware ? wrapLanguageModel({ model: rawModel as LanguageModelV3, middleware }) : rawModel;

  // ── Prepare messages with time context ──
  const enrichedMessages = injectTimeContext(messages).map((m) => ({
    role: m.role as 'user' | 'assistant' | 'system',
    content: m.content,
  }));

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
    stopWhen: stepCountIs(maxSteps),
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
  });

  return { streamResult, startTime, modelId: modelConfig.model };
}

// ─── Final-Answer Guarantee ──────────────────────────────

/**
 * The agent loop occasionally exhausts its step budget calling tools without
 * ever emitting an assistant answer — the model keeps searching until
 * `stopWhen` cuts it off (or still tries to call a tool on the forced
 * `toolChoice: 'none'` final step), and the consumer receives an empty
 * assistant turn. `withFinalAnswerGuarantee` below closes that hole for every
 * host and every model.
 */
interface FinalAnswerContext {
  profile: EngineProfile;
  systemPrompt: string;
  /** The original conversation passed to createChatStreamAsync. */
  baseMessages: Array<{ role: string; content: string }>;
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

/**
 * Build the "answer now, no tools" continuation stream.
 *
 * The gathered evidence is flattened to plain text rather than replayed as
 * structured tool-call/tool-result messages on purpose: replaying that history
 * primes the model to keep calling tools, which is exactly the loop being
 * escaped. Thinking is disabled for speed, and `tools: {}` + `toolChoice:
 * 'none'` make a text answer the only possible output.
 */
async function createFinalAnswerStreamAsync(
  ctx: FinalAnswerContext,
  priorResult: StreamTextResult<ToolSet, never>,
): Promise<StreamTextResult<ToolSet, never>> {
  const modelConfig: ModelConfig = {
    ...ctx.profile.model,
    options: { ...ctx.profile.model.options, thinking: false },
  };
  // Same creation path as the primary stream so fork-registered provider
  // middleware still applies here.
  const rawModel = await createModelFromConfig(modelConfig);
  const middleware = getProviderMiddleware(modelConfig.provider);
  const model = middleware ? wrapLanguageModel({ model: rawModel as LanguageModelV3, middleware }) : rawModel;

  const digest = digestToolResults((await priorResult.response).messages ?? []);
  const messages: ModelMessage[] = [
    ...injectTimeContext(ctx.baseMessages).map(
      (m) => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content }) as ModelMessage,
    ),
    {
      role: 'user',
      content:
        `[Information already gathered by tools:]\n\n${digest || '(no results)'}\n\n` +
        `[Tool use is now disabled. Using only the information above, answer my most recent question in plain text. ` +
        `If the information is insufficient, say so briefly. Do not call any tools.]`,
    },
  ];

  const providerOptions = buildProviderOptions(modelConfig);

  return streamText({
    model,
    system: ctx.systemPrompt,
    messages,
    tools: {},
    toolChoice: 'none',
    ...(providerOptions ? { providerOptions } : {}),
  });
}

/**
 * One final-answer pass, emitted as synthetic fullStream `text-delta` parts
 * and retried up to `maxAttempts` while a pass yields nothing (a pass can come
 * back empty on intermittent provider quirks — e.g. a tool-call leak stripped
 * by fork middleware). Empty passes yield nothing, so retrying never
 * duplicates content.
 */
async function* finalAnswerParts(
  ctx: FinalAnswerContext,
  priorResult: StreamTextResult<ToolSet, never>,
  maxAttempts = 3,
): AsyncGenerator<{ type: 'text-delta'; id: string; text: string }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let produced = '';
    try {
      const continuation = await createFinalAnswerStreamAsync(ctx, priorResult);
      for await (const part of continuation.fullStream) {
        if (part.type === 'text-delta' && part.text) {
          produced += part.text;
          yield { type: 'text-delta', id: 'final-answer', text: part.text };
        }
      }
    } catch (err) {
      logger.warn('[chat-engine] final-answer attempt failed', { attempt, err: String(err) });
    }
    if (produced.trim()) return;
  }
}

/**
 * Wrap a primary chat stream so it never ends with an empty assistant answer.
 *
 * Hosts iterate THIS instead of `streamResult.fullStream` — the only line they
 * change. Mechanics: pass every part through untouched but hold back the
 * terminal `finish` part; if the loop ran tools yet produced no text, splice
 * in the final-answer parts (as ordinary `text-delta`s, so host switches and
 * collectors need no special-casing) before finally emitting `finish`. Streams
 * that produced text — or never ran a tool (nothing gathered to answer from) —
 * pass through byte-identical.
 */
export async function* withFinalAnswerGuarantee(
  streamResult: StreamTextResult<ToolSet, never>,
  ctx: FinalAnswerContext,
): AsyncGenerator<any> {
  let sawText = false;
  let toolRan = false;
  let finishPart: any = null;

  for await (const part of streamResult.fullStream as AsyncIterable<any>) {
    if (part.type === 'text-delta' && part.text) sawText = true;
    else if (part.type === 'tool-result') toolRan = true;
    if (part.type === 'finish') {
      finishPart = part; // defer until after any spliced-in answer
      continue;
    }
    yield part;
  }

  if (!sawText && toolRan) {
    yield* finalAnswerParts(ctx, streamResult);
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
  streamCompleted: boolean;
  /** Local tool markers detected — frontend should execute these via the desktop bridge. */
  localToolRequests: Array<{ toolCallId: string; toolId: string; params: Record<string, unknown> }>;
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
    streamCompleted: false,
    localToolRequests: [],
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

      // Detect local tool markers (Desktop client-side execution)
      if (isLocalToolMarker(toolOutput)) {
        collectors.localToolRequests.push({
          toolCallId: part.toolCallId,
          toolId: toolOutput.toolId,
          params: toolOutput.params,
        });
      }

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

      // Track knowledge-base search relevance scores (keyed by doc_id).
      const isKnowledgeTool = part.toolName === 'knowledge_query';
      if (isKnowledgeTool && toolOutput.action === 'search' && toolOutput.results) {
        for (const result of toolOutput.results as Array<{ doc_id?: string; relevance?: number }>) {
          if (result.doc_id && result.relevance != null) {
            collectors.searchRelevance.set(result.doc_id, result.relevance);
          }
        }
      }

      // Collect references from knowledge-base docs actually read (action=get).
      if (isKnowledgeTool && toolOutput.action === 'get' && !toolOutput.error) {
        const docId = (toolOutput.doc_id as string) ?? '';
        if (docId) {
          collectors.referencesMap.set(docId, {
            slug: docId,
            doc_id: docId,
            title: (toolOutput.title as string) ?? '',
            type: 'wiki',
            category: (toolOutput.category as string) ?? undefined,
            relevance: collectors.searchRelevance.get(docId),
          });
        }
      }

      collectors.activeToolInputs.delete(part.toolCallId);
      break;
    }

    case 'start-step':
      collectors.stepStartTime = Date.now();
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
  startTime: number,
): Promise<ChatEngineResult> {
  const [finalText, finalUsage, finalReasoningText] = await Promise.all([
    Promise.resolve(streamResult.text).catch(() => ''),
    Promise.resolve(streamResult.totalUsage).catch(() => null),
    Promise.resolve(streamResult.reasoningText).catch(() => undefined),
  ]);

  const durationMs = Date.now() - startTime;
  const textToUse = finalText || collectors.fullText;
  const usage = finalUsage as any;

  return {
    text: textToUse,
    reasoningText: collectors.reasoningText || (finalReasoningText as string) || undefined,
    usage: {
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cachedInputTokens: usage?.cachedInputTokens ?? 0,
      reasoningTokens: usage?.reasoningTokens ?? 0,
    },
    pipelineSteps: collectors.pipelineSteps,
    references: [...collectors.referencesMap.values()],
    durationMs,
  };
}
