/**
 * Shared helpers for LLM-as-judge scoring.
 *
 * The eval engines (eval.ts, chat-eval.ts) all parse a
 * judge model's JSON output into clamped {score, reason} dimensions. The per-engine
 * dimension sets and validation differ, but the scoring primitives below are identical.
 */

/**
 * Clamp a judge score into the `min`–10 range, treating NaN as the minimum.
 *
 * Default min is 1 (the historical floor used by batch eval). Chat
 * eval passes min=0 so a high-risk safety/consistency failure can score a true 0.
 */
export function clampScore(v: number, min = 1): number {
  return Math.min(10, Math.max(min, isNaN(v) ? min : v));
}

/**
 * Extract a clamped {score, reason} pair from a raw judge dimension object
 * (e.g. `parsed.accuracy`). Missing fields default to `min` and an empty reason.
 */
export function scoreDimension(raw: unknown, min = 1): { score: number; reason: string } {
  const obj = (raw ?? {}) as Record<string, unknown>;
  return {
    score: clampScore((obj.score as number) ?? min, min),
    reason: (obj.reason as string) ?? '',
  };
}
