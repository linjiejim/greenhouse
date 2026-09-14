/**
 * LLM Completion Layer — profile-based non-streaming calls.
 *
 * Provides complete() and completeJson() for single-turn LLM tasks
 * (source enrichment, eval judging, content generation, etc.)
 *
 * For multi-turn streaming (chat), use streamText() directly with
 * createModelFromConfig() — see api/routes/chat.ts.
 *
 * Extracted from api/llm.ts to serve as a shared layer.
 */

import { generateText, Output } from 'ai';
import { createModelFromConfig, buildProviderOptions, resolveModelConfig } from '@greenhouse/agent-core';
import { resolveProfileAsync } from '../profiles/profile.js';
import type { AgentProfile } from '../profiles/profile.js';
import { extractJson } from '@greenhouse/utils/json';
import { getDb } from '@greenhouse/db';
import { createProviderAttemptBudgetHook } from './usage-budget.js';

// ─── Types ───────────────────────────────────────────────

export interface CompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionOptions {
  /** Chat messages (system prompt from profile is prepended automatically) */
  messages: CompletionMessage[];
  /** Override profile's default temperature */
  temperature?: number;
  /** Override profile's default max_tokens */
  maxTokens?: number;
  /** Max retry attempts (default: 3) */
  maxRetries?: number;
  /** Override the profile's system prompt (useful for task-specific prompts) */
  systemPrompt?: string;
  /** Caller identifier for usage tracking: 'compiler', 'judge', 'api', etc. */
  caller?: string;
  /** Authenticated internal owner whose hard monthly budget this call consumes. */
  userId: string;
  sessionId?: string;
  /** Request JSON output mode — model returns valid JSON without markdown fences */
  responseFormat?: 'json';
  /** Propagate durable Runtime cancellation into provider I/O. */
  abortSignal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    reasoningTokens: number;
  };
}

// ─── Rate Limiter ────────────────────────────────────────

const MIN_INTERVAL_MS = 300;
let lastCallTime = 0;

async function rateLimit(): Promise<void> {
  const elapsed = Date.now() - lastCallTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - elapsed));
  }
}

// ─── Core Functions ──────────────────────────────────────

/**
 * Single-turn text completion using an agent profile.
 *
 * The profile provides: model config, system prompt, default temperature/maxTokens.
 * Options can override any of these per-call.
 *
 * @example
 * ```ts
 * const result = await complete('team', {
 *   messages: [{ role: 'user', content: 'Compile a wiki page for...' }],
 *   userId: authenticatedUser.id,
 *   maxTokens: 12000,
 * });
 * console.log(result.text);
 * ```
 */
export async function complete(
  profileOrId: AgentProfile | string,
  options: CompletionOptions,
): Promise<CompletionResult> {
  const profile = typeof profileOrId === 'string' ? await resolveProfileAsync(profileOrId) : profileOrId;

  // Same layering as the chat path: catalog options for the model, profile
  // options on top (see resolveModelConfig).
  const modelConfig = resolveModelConfig(profile.model);
  const caller = options.caller ?? 'api';
  const db = getDb();
  const providerAttemptHook = createProviderAttemptBudgetHook({
    db,
    userId: options.userId,
    caller,
    profileId: profile.id,
    ...(options.sessionId ? { sessionId: options.sessionId, runId: options.sessionId } : {}),
    metadata: { response_format: options.responseFormat ?? null },
  });
  const model = await createModelFromConfig(modelConfig, { onProviderAttempt: providerAttemptHook });
  const providerOptions = buildProviderOptions(modelConfig);
  const temperature = options.temperature ?? (modelConfig.options?.temperature as number | undefined) ?? 0.7;
  const maxTokens = options.maxTokens ?? (modelConfig.options?.max_tokens as number | undefined) ?? 4096;
  const systemPrompt = options.systemPrompt ?? profile.system_prompt;

  await rateLimit();

  const result = await generateText({
    model,
    system: systemPrompt,
    messages: options.messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    temperature,
    maxOutputTokens: maxTokens,
    maxRetries: options.maxRetries ?? 3,
    ...(providerOptions ? { providerOptions } : {}),
    ...(options.responseFormat === 'json' ? { output: Output.json() } : {}),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  });

  lastCallTime = Date.now();

  return {
    text: result.text,
    usage: result.usage
      ? {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
          cachedTokens: ((result.usage as Record<string, unknown>).cachedInputTokens as number) ?? 0,
          reasoningTokens: ((result.usage as Record<string, unknown>).reasoningTokens as number) ?? 0,
        }
      : undefined,
  };
}

/**
 * Single-turn JSON completion — appends JSON instruction and parses response.
 *
 * @example
 * ```ts
 * const plan = await completeJson<{ topics: TopicPlan[] }>('team', {
 *   messages: [{ role: 'user', content: 'Plan topic pages...' }],
 * });
 * ```
 */
export async function completeJson<T = Record<string, unknown>>(
  profileOrId: AgentProfile | string,
  options: CompletionOptions,
): Promise<T> {
  // Append JSON-only instruction to the last user message
  const messages = options.messages.map((m) => ({ ...m }));
  const last = messages[messages.length - 1];
  if (last?.role === 'user') {
    last.content += '\n\nRespond with valid JSON only. No markdown code fences.';
  }

  const result = await complete(profileOrId, { ...options, messages });
  const jsonStr = extractJson(result.text);
  if (!jsonStr) {
    throw new Error(`Cannot extract JSON from LLM response: ${result.text.slice(0, 300)}`);
  }
  return JSON.parse(jsonStr) as T;
}
