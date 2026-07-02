/**
 * Model price table — ESTIMATED USD cost per token, for admin analytics only.
 *
 * ⚠️ These are rough public list prices, NOT billed amounts. They drift as
 * providers change pricing and as the gateway routes to different upstreams, so
 * every figure derived from this table MUST be surfaced to the user as an
 * estimate (the tool labels its money fields `*_usd_est` and sets
 * `cost_is_estimate: true`). To update: edit PRICES below — matching is by
 * longest-substring on the model id, so family prefixes suffice.
 *
 * Kept in the API layer (not the DB service) on purpose: pricing is volatile
 * policy, while the DB analytics service stays a pure, content-free data source.
 */

/** Per-MILLION-token prices (USD). `cached` is the cache-READ (discounted) rate. */
export interface ModelPrice {
  input: number;
  output: number;
  cached: number;
}

/**
 * Keyed by a substring of the model id; the LONGEST matching key wins (so
 * 'claude-haiku' beats 'claude'). Prices are per 1,000,000 tokens, USD.
 * Sources: provider public pricing pages, early 2026 — estimates only.
 */
const PRICES: Record<string, ModelPrice> = {
  // ── Anthropic Claude ──
  'claude-opus': { input: 15, output: 75, cached: 1.5 },
  'claude-sonnet': { input: 3, output: 15, cached: 0.3 },
  'claude-haiku': { input: 0.8, output: 4, cached: 0.08 },
  'claude-3-opus': { input: 15, output: 75, cached: 1.5 },
  'claude-3-5-sonnet': { input: 3, output: 15, cached: 0.3 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cached: 0.08 },
  // ── OpenAI ──
  'gpt-4o-mini': { input: 0.15, output: 0.6, cached: 0.075 },
  'gpt-4o': { input: 2.5, output: 10, cached: 1.25 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cached: 0.1 },
  'gpt-4.1': { input: 2, output: 8, cached: 0.5 },
  'o3-mini': { input: 1.1, output: 4.4, cached: 0.55 },
  o3: { input: 2, output: 8, cached: 0.5 },
  'o1-mini': { input: 1.1, output: 4.4, cached: 0.55 },
  o1: { input: 15, output: 60, cached: 7.5 },
  // ── Google Gemini ──
  'gemini-2.0-flash': { input: 0.1, output: 0.4, cached: 0.025 },
  'gemini-1.5-pro': { input: 1.25, output: 5, cached: 0.3125 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3, cached: 0.01875 },
  // ── DeepSeek ──
  'deepseek-chat': { input: 0.27, output: 1.1, cached: 0.07 },
  'deepseek-reasoner': { input: 0.55, output: 2.19, cached: 0.14 },
};

/** Token counts for one cost estimate. `reasoning` is assumed billed at the output rate. */
export interface TokenCounts {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cached_tokens?: number | null;
  reasoning_tokens?: number | null;
}

/** Find the price for a model id via longest-substring match, or null if unknown. */
export function priceForModel(model: string): ModelPrice | null {
  const id = model.toLowerCase();
  let best: ModelPrice | null = null;
  let bestLen = 0;
  for (const [key, price] of Object.entries(PRICES)) {
    if (id.includes(key) && key.length > bestLen) {
      best = price;
      bestLen = key.length;
    }
  }
  return best;
}

/**
 * Estimate the USD cost of a set of token counts for one model. Returns null when
 * the model isn't in the table (caller should count it as "unpriced", not $0).
 * Cached tokens are billed at the cache-read rate and are assumed NOT also counted
 * in input_tokens; reasoning tokens are billed at the output rate and assumed NOT
 * also counted in output_tokens. Rounded to 4 decimals.
 */
export function estimateCostUsd(model: string, tokens: TokenCounts): number | null {
  const price = priceForModel(model);
  if (!price) return null;
  const input = tokens.input_tokens ?? 0;
  const output = tokens.output_tokens ?? 0;
  const cached = tokens.cached_tokens ?? 0;
  const reasoning = tokens.reasoning_tokens ?? 0;
  const usd =
    (input / 1e6) * price.input +
    (output / 1e6) * price.output +
    (cached / 1e6) * price.cached +
    (reasoning / 1e6) * price.output;
  return Math.round(usd * 10000) / 10000;
}
