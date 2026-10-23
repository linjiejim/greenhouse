/**
 * Price computation — from the price list and measured usage to a cost in USD
 * micros (1 USD = 1_000_000).
 *
 * The price list is models.yaml / services.yaml, overridden per model or per
 * service × provider by what a super set on Services & pricing
 * (`usage_price_overrides`). Overrides are cached in-process and refreshed by
 * `syncPriceOverrides()` (every metering entry point calls it; a write
 * refreshes immediately, other processes within OVERRIDE_TTL_MS). A change
 * applies to calls settled after it; every fact keeps the price it was settled
 * at (`priceSnapshot*` → `price_applied`).
 *
 * `null` always means "unpriced": the cost is unknown, the caller records the
 * usage anyway and counts it as zero. It is never confused with a real zero
 * (`price: 0`), which is a priced, free call.
 *
 * Token prices are USD per 1M tokens, so a token costs exactly `price` micros —
 * the arithmetic below is tokens × price, rounded up once per call.
 */

import { findModelIdByProviderModel, getModelEntry, type TokenPrice } from '@greenhouse/agent-core';
import type { DatabaseProvider, UsagePriceOverrideRow } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { getServiceProviderPrice, type PricedService, type ServiceProviderPrice } from '../config/services.js';

export const USD_MICROS = 1_000_000;

// ─── Admin overrides ─────────────────────────────────────

export const OVERRIDE_TTL_MS = 30_000;
let overrides: readonly UsagePriceOverrideRow[] = [];
let overridesLoadedAt = 0;

/** Refresh the cached admin price overrides if stale (or `force`). A failed read keeps the last copy. */
export async function syncPriceOverrides(db: DatabaseProvider, force = false): Promise<void> {
  if (!force && Date.now() - overridesLoadedAt < OVERRIDE_TTL_MS) return;
  try {
    overrides = await db.metering.listPriceOverrides();
    overridesLoadedAt = Date.now();
  } catch (err) {
    logger.warn('[pricing] could not read price overrides; keeping the last copy', { error: toErrorMessage(err) });
  }
}

/** Test seam: install overrides directly (empty to clear). */
export function setPriceOverridesForTests(rows: readonly UsagePriceOverrideRow[]): void {
  overrides = rows;
  overridesLoadedAt = rows.length > 0 ? Date.now() : 0;
}

export function currentPriceOverrides(): readonly UsagePriceOverrideRow[] {
  return overrides;
}

function overrideFor(kind: UsagePriceOverrideRow['kind'], target: string, provider = '') {
  return overrides.find((row) => row.kind === kind && row.target === target && row.provider === provider);
}

function overrideTokenPrice(row: UsagePriceOverrideRow): TokenPrice | undefined {
  if (row.input_per_mtok === null || row.output_per_mtok === null) return undefined;
  return {
    input: row.input_per_mtok,
    output: row.output_per_mtok,
    ...(row.cached_input_per_mtok !== null ? { cachedInput: row.cached_input_per_mtok } : {}),
  };
}

export type PriceSource = 'override' | 'config';

/** One provider's effective price: the admin override if set, else the file. */
export interface EffectiveServicePrice extends Pick<ServiceProviderPrice, 'price' | 'priceBySize' | 'tokenPrice'> {
  source: PriceSource;
}

export function effectiveServicePrice(service: PricedService, provider: string): EffectiveServicePrice | undefined {
  const row = overrideFor('service', service, provider);
  if (row) {
    const tokenPrice = overrideTokenPrice(row);
    return {
      source: 'override',
      ...(row.unit_price !== null ? { price: row.unit_price } : {}),
      ...(tokenPrice ? { tokenPrice } : {}),
    };
  }
  const entry = getServiceProviderPrice(service, provider);
  if (!entry) return undefined;
  return {
    source: 'config',
    ...(entry.price !== undefined ? { price: entry.price } : {}),
    ...(entry.priceBySize ? { priceBySize: entry.priceBySize } : {}),
    ...(entry.tokenPrice ? { tokenPrice: entry.tokenPrice } : {}),
  };
}

/** The catalog id a call's model resolves to (flash / pro / …), if any. */
export function catalogModelId(modelId?: string, logicalModelId?: string): string | undefined {
  for (const id of [logicalModelId, modelId]) if (id && getModelEntry(id)) return id;
  return modelId ? findModelIdByProviderModel(modelId) : undefined;
}

export function effectiveModelPrice(
  modelId?: string,
  logicalModelId?: string,
): { price: TokenPrice; source: PriceSource; model: string } | undefined {
  const id = catalogModelId(modelId, logicalModelId);
  if (!id) return undefined;
  const row = overrideFor('model', id);
  const override = row ? overrideTokenPrice(row) : undefined;
  if (override) return { price: override, source: 'override', model: id };
  const price = getModelEntry(id)?.price;
  return price ? { price, source: 'config', model: id } : undefined;
}

// ─── Applied-price snapshots (llm_usage / service_usage `price_applied`) ─

export function tokenPriceSnapshot(price: TokenPrice, source: PriceSource, extra: Record<string, unknown> = {}) {
  return {
    source,
    input_per_mtok: price.input,
    output_per_mtok: price.output,
    cached_input_per_mtok: price.cachedInput ?? price.input,
    ...extra,
  };
}

export function unitPriceSnapshot(unitPrice: number, source: PriceSource, extra: Record<string, unknown> = {}) {
  return { source, unit_price: unitPrice, ...extra };
}

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
  return effectiveModelPrice(modelId, logicalModelId)?.price;
}

/** USD per unit × units, for call / minute services. */
export function serviceUnitCostMicros(service: PricedService, provider: string, units: number): number | null {
  const price = effectiveServicePrice(service, provider)?.price;
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
  const entry = effectiveServicePrice('image_generation', input.provider);
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
  const usd = imageUnitPrice(entry, input.quality, input.size);
  return usd === undefined ? null : usdToMicros(usd);
}

/** USD for one image at this quality and size (an override's flat price wins over the size table). */
export function imageUnitPrice(entry: EffectiveServicePrice, quality: string, size: string): number | undefined {
  if (entry.source === 'override') return entry.price;
  return entry.priceBySize?.[quality]?.[size] ?? entry.price;
}

/**
 * The most an image of this quality could cost — the reservation when the size
 * is only known afterwards (an edit that keeps the source's aspect ratio).
 */
export function maxImageCostMicros(provider: string, quality: string): number | null {
  const entry = effectiveServicePrice('image_generation', provider);
  if (!entry) return null;
  if (entry.source === 'override') return entry.price === undefined ? null : usdToMicros(entry.price);
  const sizes = Object.values(entry.priceBySize?.[quality] ?? {});
  if (sizes.length > 0) return usdToMicros(Math.max(...sizes));
  return entry.price === undefined ? null : usdToMicros(entry.price);
}

/** USD per 1M tokens for a token-priced service (image understanding). */
export function serviceTokenPrice(service: PricedService, provider: string): TokenPrice | undefined {
  return effectiveServicePrice(service, provider)?.tokenPrice;
}
