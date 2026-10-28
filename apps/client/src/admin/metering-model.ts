/** Services & pricing rules (React-free, tested): which words a key takes and what a price dialog edits. */
import type { ModelPrice, PriceInput, ServicePrice, ServiceProvider, ServiceUnit } from './types';
import { parsePrice } from './format';

export const METERED_SERVICES = ['llm', 'vision', 'web_search', 'page_read', 'image_generation', 'computer'] as const;
export const METERING_CLIENTS = [
  'web',
  'mobile',
  'desktop',
  'mcp',
  'agent_api',
  'automation',
  'feishu',
  'gateway',
  'system',
] as const;

export type MeteredService = (typeof METERED_SERVICES)[number];
export type MeteringClient = (typeof METERING_CLIENTS)[number] | 'unknown';

export const knownService = (key: string): key is MeteredService =>
  (METERED_SERVICES as readonly string[]).includes(key);
export const clientKey = (key: string): MeteringClient =>
  (METERING_CLIENTS as readonly string[]).includes(key) ? (key as MeteringClient) : 'unknown';

/** What the price dialog edits: tokens (input/output/cached) or one unit price. */
export interface PriceTarget {
  kind: PriceInput['kind'];
  target: string;
  provider?: string;
  name: string;
  unit: ServiceUnit;
  current: { input?: number; output?: number; cached_input?: number | null; unit_price?: number };
}

export function serviceTarget(service: ServicePrice, provider: ServiceProvider, name: string): PriceTarget {
  return {
    kind: 'service',
    target: service.service,
    provider: provider.provider,
    name: `${name} · ${provider.provider}`,
    unit: service.unit,
    current: {
      ...(provider.token_price
        ? {
            input: provider.token_price.input,
            output: provider.token_price.output,
            cached_input: provider.token_price.cached_input,
          }
        : {}),
      ...(provider.price !== null ? { unit_price: provider.price } : {}),
    },
  };
}

export function modelTarget(model: ModelPrice): PriceTarget {
  return {
    kind: 'model',
    target: model.id,
    name: model.name,
    unit: 'token',
    current: model.price
      ? { input: model.price.input, output: model.price.output, cached_input: model.price.cached_input }
      : {},
  };
}

/** The PUT body for typed prices, or null while a field does not parse (cached input may be empty). */
export function priceInput(
  target: PriceTarget,
  typed: { input: string; output: string; cached: string; unit: string },
): PriceInput | null {
  const base = { kind: target.kind, target: target.target, ...(target.provider ? { provider: target.provider } : {}) };
  if (target.unit !== 'token') {
    const unit_price = parsePrice(typed.unit);
    return unit_price === null ? null : { ...base, unit_price };
  }
  const input = parsePrice(typed.input);
  const output = parsePrice(typed.output);
  const cached = typed.cached.trim() ? parsePrice(typed.cached) : null;
  if (input === null || output === null || (typed.cached.trim() && cached === null)) return null;
  return { ...base, input, output, cached_input: cached };
}

/** `0.15`, never `1.5e-7`; empty for absent. */
export const priceText = (value: number | null | undefined) =>
  value === null || value === undefined ? '' : String(Number(value.toFixed(6)));
