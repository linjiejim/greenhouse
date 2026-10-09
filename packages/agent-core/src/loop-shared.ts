/**
 * Leaf definitions shared by the loop assembly (agent-loop.ts) and the
 * final-answer fallback (final-answer.ts) — kept apart so neither imports the
 * other's module just for a constant.
 */

import type { ModelMessage } from 'ai';
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

/**
 * Bound every agent turn at the SDK layer, independently from any transport
 * keepalive (the chat route's NDJSON ping).
 *
 * `chunkMs` also spans local tool execution in AI SDK v6, so it must stay above
 * the observed 30–100s image-generation window. The total bound prevents a
 * multi-step agent loop from living forever — streaming or headless.
 */
export const CHAT_STREAM_TIMEOUT = {
  totalMs: 15 * 60_000,
  stepMs: 4 * 60_000,
  chunkMs: 2 * 60_000,
} as const;

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
