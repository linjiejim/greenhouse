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
import { createModelFromConfig, buildProviderOptions } from '@greenhouse/agent-core';
import { resolveProfile } from '../profile.js';
import type { AgentProfile } from '../profile.js';
import { extractJson } from '@greenhouse/utils/json';

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
  /** Request JSON output mode — model returns valid JSON without markdown fences */
  responseFormat?: 'json';
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
 * const result = await complete('admin', {
 *   messages: [{ role: 'user', content: 'Compile a wiki page for...' }],
 *   maxTokens: 12000,
 * });
 * console.log(result.text);
 * ```
 */
export async function complete(
  profileOrId: AgentProfile | string,
  options: CompletionOptions,
): Promise<CompletionResult> {
  const profile = typeof profileOrId === 'string' ? resolveProfile(profileOrId) : profileOrId;

  const model = await createModelFromConfig(profile.model);
  const providerOptions = buildProviderOptions(profile.model);

  const temperature = options.temperature ?? (profile.model.options?.temperature as number | undefined) ?? 0.7;
  const maxTokens = options.maxTokens ?? (profile.model.options?.max_tokens as number | undefined) ?? 4096;
  const systemPrompt = options.systemPrompt ?? profile.system_prompt;

  await rateLimit();

  const startTime = Date.now();

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
  });

  lastCallTime = Date.now();
  const durationMs = Date.now() - startTime;

  // Fire-and-forget usage recording
  if (result.usage) {
    import('@greenhouse/db')
      .then(({ getDb, isDbInitialized }) => {
        if (!isDbInitialized()) return;
        getDb()
          .usage.record({
            profile_id: profile.id,
            caller: options.caller ?? 'api',
            model: profile.model.model,
            input_tokens: result.usage.inputTokens ?? 0,
            output_tokens: result.usage.outputTokens ?? 0,
            cached_tokens: ((result.usage as Record<string, unknown>).cachedInputTokens as number) ?? 0,
            reasoning_tokens: ((result.usage as Record<string, unknown>).reasoningTokens as number) ?? 0,
            duration_ms: durationMs,
          })
          .catch(() => {});
      })
      .catch(() => {});
  }

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
 * const plan = await completeJson<{ topics: TopicPlan[] }>('admin', {
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
