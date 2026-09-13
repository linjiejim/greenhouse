/**
 * Context budget — pre-send guard for unbounded conversation history.
 *
 * The chat route loads a session's ENTIRE user/assistant history every turn.
 * Without a bound, a long-lived session grows until the provider rejects the
 * request with a context-length error — and burns input tokens on ancient
 * messages every turn until then. This module gives hosts a cheap,
 * dependency-free window: estimate tokens per message, keep the newest
 * messages within a budget, drop the oldest whole messages beyond it.
 *
 * Deliberately NOT a summarizer. Rolling compaction changes what the model can
 * recall and is a product decision; this is only the safety floor under it.
 */

import { getModelEntry } from './registry.js';

/**
 * Fallback history budget in estimated tokens, used only for models whose
 * catalog entry declares no `contextWindow`. Sized for 128k-class context
 * windows: leaves ample room for the system prompt (~4k), tool definitions
 * (~8–12k), reasoning and the output cap (20k) on top of the history.
 * Models WITH a declared window get `contextWindow × compactionThreshold`
 * via resolveHistoryBudget() instead.
 */
export const HISTORY_TOKEN_BUDGET = 80_000;

/**
 * Default compaction trigger as a fraction of the model's context window.
 * At this point history gets acted on (today: drop-oldest; later:
 * fold-summarization) — the other half stays free for system prompt, tools,
 * intra-turn tool outputs, reasoning and the output cap.
 */
export const DEFAULT_COMPACTION_THRESHOLD = 0.5;

/**
 * History budget for one chat turn, derived from the model catalog:
 * `contextWindow × compactionThreshold` (threshold defaults to 50%).
 * Unknown models — or entries without a declared window — fall back to the
 * conservative HISTORY_TOKEN_BUDGET so a catalog gap can never overflow a
 * small-window model.
 */
export function resolveHistoryBudget(modelId?: string): number {
  const entry = modelId ? getModelEntry(modelId) : undefined;
  if (!entry?.contextWindow) return HISTORY_TOKEN_BUDGET;
  return Math.floor(entry.contextWindow * (entry.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD));
}

/** Rough token estimate: CJK ≈ 1 token per char, everything else ≈ 4 chars per token. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let total = 0;
  for (const ch of text) {
    total++;
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x2e80 && code <= 0x9fff) || // CJK radicals, kana, unified ideographs
      (code >= 0xf900 && code <= 0xfaff) || // compatibility ideographs
      (code >= 0xff00 && code <= 0xffef) || // full-width forms
      (code >= 0x20000 && code <= 0x2ffff) // extension B and beyond
    ) {
      cjk++;
    }
  }
  return cjk + Math.ceil((total - cjk) / 4);
}

export interface HistoryWindowResult<T> {
  /** The retained (newest) slice, in original order. */
  messages: T[];
  /** How many oldest messages were dropped. */
  dropped: number;
  /** Estimated tokens of the retained slice. */
  estimatedTokens: number;
}

/**
 * Keep the newest messages whose estimated tokens fit `budget`; drop the
 * oldest whole messages beyond it. The newest message is always kept even if
 * it alone exceeds the budget — the current turn must reach the model.
 */
export function windowMessagesByBudget<T extends { content: string }>(
  messages: T[],
  budget: number = HISTORY_TOKEN_BUDGET,
): HistoryWindowResult<T> {
  let total = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = estimateTokens(messages[i].content);
    const isNewest = i === messages.length - 1;
    if (!isNewest && total + cost > budget) break;
    total += cost;
    start = i;
  }
  return {
    messages: start === 0 ? messages : messages.slice(start),
    dropped: start,
    estimatedTokens: total,
  };
}
