/**
 * Leaf definitions shared by the loop assembly (agent-loop.ts) and the
 * final-answer fallback (final-answer.ts) — kept apart so neither imports the
 * other's module just for a constant.
 */

import type { ModelMessage, streamText, ToolSet } from 'ai';
import type { ModelConfig } from './model.js';
import { injectTimeContext, type EngineMessage } from './time-context.js';

/**
 * The slice of an agent profile the loop actually consumes. Hosts pass their
 * full profile objects (e.g. the api's YAML AgentProfile) — structural typing
 * keeps the kernel decoupled from host profile schemas.
 */
export interface EngineProfile {
  model: ModelConfig;
  max_steps?: number;
  tool_choice?: 'auto' | 'none' | 'required';
}

/** What `streamText` returns for a turn of the shared loop (every generic at its default). */
export type AgentStreamResult = ReturnType<typeof streamText<ToolSet>>;

/**
 * Bound every agent turn at the SDK layer, independently from any transport
 * keepalive (the chat route's NDJSON ping).
 *
 * AI SDK 7 splits what v6's `chunkMs` covered: `stepMs` bounds a whole step
 * INCLUDING local tool execution (so it must stay above the observed 30–100s
 * image-generation window), `firstChunkMs` bounds the wait for a step's first
 * output and `chunkMs` the silence between outputs (both streaming only).
 * Together they keep v6's "two minutes without a chunk" bound. The total bound
 * prevents a multi-step agent loop from living forever — streaming or headless.
 */
export const CHAT_STREAM_TIMEOUT = {
  totalMs: 15 * 60_000,
  stepMs: 4 * 60_000,
  firstChunkMs: 2 * 60_000,
  chunkMs: 2 * 60_000,
} as const;

// ─── Usage ───────────────────────────────────────────────

/** Token usage in the kernel's own (flat, always-numeric) shape. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
}

export function emptyUsageTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Read an AI SDK usage object into the flat shape. AI SDK 7 dropped the
 * top-level `cachedInputTokens` / `reasoningTokens` (v6 kept them as deprecated
 * aliases) in favour of `inputTokenDetails.cacheReadTokens` /
 * `outputTokenDetails.reasoningTokens`; reading only the old names would
 * silently zero both. Already-flat objects (our own) pass through.
 */
export function usageTotalsFrom(usage: unknown): UsageTotals {
  if (!usage || typeof usage !== 'object') return emptyUsageTotals();
  const u = usage as {
    inputTokens?: unknown;
    outputTokens?: unknown;
    cachedInputTokens?: unknown;
    reasoningTokens?: unknown;
    inputTokenDetails?: { cacheReadTokens?: unknown };
    outputTokenDetails?: { reasoningTokens?: unknown };
  };
  return {
    inputTokens: count(u.inputTokens),
    outputTokens: count(u.outputTokens),
    cachedInputTokens: count(u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens),
    reasoningTokens: count(u.outputTokenDetails?.reasoningTokens ?? u.reasoningTokens),
  };
}

/** Add an AI SDK (or flat) usage object onto running totals. */
export function addUsage(target: UsageTotals, usage: unknown): void {
  const add = usageTotalsFrom(usage);
  target.inputTokens += add.inputTokens;
  target.outputTokens += add.outputTokens;
  target.cachedInputTokens += add.cachedInputTokens;
  target.reasoningTokens += add.reasoningTokens;
}

/**
 * Time context for the turn's user messages: default on (Asia/Shanghai, the
 * chat convention), `{ timezone }` to pick another zone, or `false` for a host
 * whose prompt already carries its own timezone-aware stamp (the scheduler) —
 * two clocks in one prompt disagree as soon as the zones differ.
 */
export type TimeContextOption = false | { timezone?: string };

/** Stamp (or not) the messages and shape them for the SDK. */
export function applyTimeContext(messages: EngineMessage[], option: TimeContextOption | undefined): ModelMessage[] {
  const stamped =
    option === false
      ? messages.map((m) => ({ role: m.role, content: m.content }))
      : injectTimeContext(messages, option?.timezone);
  // Cast: only user messages ever carry image parts (chat-vision contract),
  // which is exactly what ModelMessage's per-role content types require.
  return stamped.map((m) => ({
    role: m.role as 'user' | 'assistant' | 'system',
    content: m.content,
  })) as ModelMessage[];
}
