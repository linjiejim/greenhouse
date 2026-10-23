/**
 * Price computation — pure functions from a price list and measured usage to a
 * cost in USD micros (1 USD = 1_000_000).
 *
 * `null` always means "unpriced": the cost is unknown, the caller records the
 * usage anyway and counts it as zero. It is never confused with a real zero
 * (`price: 0`), which is a priced, free call.
 *
 * Token prices are USD per 1M tokens, so a token costs exactly `price` micros —
 * the arithmetic below is tokens × price, rounded up once per call.
 */

import { findModelIdByProviderModel, getModelEntry, type TokenPrice } from '@greenhouse/agent-core';
import { getServiceProviderPrice, type PricedService } from '../config/services.js';

export const USD_MICROS = 1_000_000;

/**
 * Round a fractional micro amount up, after discarding float noise
 * (0.008 USD × 1e6 is 8000.000000000001, which must stay 8000).
 */
function ceilMicros(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(Number(value.toFixed(6)));
}

export function usdToMicros(usd: number): number {
  return ceilMicros(usd * USD_MICROS);
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Portion of inputTokens served from the provider's prompt cache. */
  cachedInputTokens?: number;
}

/**
 * Actual cost of one call. Cached input is billed at `cachedInput` (defaults to
 * the input price); output includes reasoning tokens, as providers bill them.
 */
export function tokenCostMicros(price: TokenPrice | undefined, usage: TokenUsage): number | null {
  if (!price) return null;
  const input = Math.max(0, usage.inputTokens);
  const cached = Math.min(input, Math.max(0, usage.cachedInputTokens ?? 0));
  const output = Math.max(0, usage.outputTokens);
  const cachedPrice = price.cachedInput ?? price.input;
  return ceilMicros((input - cached) * price.input + cached * cachedPrice + output * price.output);
}

/** Upper bound for a reservation: every input token uncached. */
export function estimateTokenCostMicros(
  price: TokenPrice | undefined,
  estimate: { inputTokens: number; outputTokens: number },
): number | null {
  if (!price) return null;
  return ceilMicros(
    Math.max(0, estimate.inputTokens) * price.input + Math.max(0, estimate.outputTokens) * price.output,
  );
}

/**
 * A chat model's price: by catalog id first (flash / pro / …), then by the raw
 * provider model id a call reports (`deepseek-v4-flash` → its catalog entry).
 */
export function modelPrice(modelId?: string, logicalModelId?: string): TokenPrice | undefined {
  for (const id of [logicalModelId, modelId]) {
    if (!id) continue;
    const direct = getModelEntry(id);
    if (direct) return direct.price;
  }
  const byProviderModel = modelId ? findModelIdByProviderModel(modelId) : undefined;
  return byProviderModel ? getModelEntry(byProviderModel)?.price : undefined;
}

/** USD per unit × units, for call / minute services. */
export function serviceUnitCostMicros(service: PricedService, provider: string, units: number): number | null {
  const price = getServiceProviderPrice(service, provider)?.price;
  if (price === undefined) return null;
  return ceilMicros(price * USD_MICROS * Math.max(0, units));
}

/**
 * The most one unit could cost across the providers a call may fall through —
 * the reservation for a search whose provider is only known afterwards. Null
 * when none of them is priced.
 */
export function maxServiceUnitCostMicros(service: PricedService, providers: readonly string[]): number | null {
  let max: number | null = null;
  for (const provider of providers) {
    const cost = serviceUnitCostMicros(service, provider, 1);
    if (cost !== null) max = Math.max(max ?? 0, cost);
  }
  return max;
}

/**
 * One generated image. Token pricing wins when the provider declares it and the
 * response reported usage; otherwise the size table for that quality.
 */
export function imageCostMicros(input: {
  provider: string;
  quality: string;
  size: string;
  usage?: { inputTokens?: number; outputTokens?: number } | null;
}): number | null {
  const entry = getServiceProviderPrice('image_generation', input.provider);
  if (!entry) return null;
  if (
    entry.tokenPrice &&
    input.usage &&
    (input.usage.inputTokens !== undefined || input.usage.outputTokens !== undefined)
  ) {
    return tokenCostMicros(entry.tokenPrice, {
      inputTokens: input.usage.inputTokens ?? 0,
      outputTokens: input.usage.outputTokens ?? 0,
    });
  }
  const usd = entry.priceBySize?.[input.quality]?.[input.size] ?? entry.price;
  return usd === undefined ? null : usdToMicros(usd);
}

/**
 * The most an image of this quality could cost — the reservation when the size
 * is only known afterwards (an edit that keeps the source's aspect ratio).
 */
export function maxImageCostMicros(provider: string, quality: string): number | null {
  const entry = getServiceProviderPrice('image_generation', provider);
  if (!entry) return null;
  const sizes = Object.values(entry.priceBySize?.[quality] ?? {});
  if (sizes.length > 0) return usdToMicros(Math.max(...sizes));
  return entry.price === undefined ? null : usdToMicros(entry.price);
}

/** USD per 1M tokens for a token-priced service (image understanding). */
export function serviceTokenPrice(service: PricedService, provider: string): TokenPrice | undefined {
  return getServiceProviderPrice(service, provider)?.tokenPrice;
}
