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

import { streamText, stepCountIs } from 'ai';
import type { StreamTextResult, ToolSet } from 'ai';
import { createModelFromConfig, buildProviderOptions, applyModelOverride, type ModelConfig } from './model.js';
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
  const model = await createModelFromConfig(modelConfig);

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
