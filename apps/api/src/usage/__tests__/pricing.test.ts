/**
 * Price computation and the service price list. `null` must always mean
 * "unpriced" and never be confused with a real zero; the file must fail the
 * boot on anything that would silently make a paid provider unpriced.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_REGISTRY, setModelRegistry } from '@greenhouse/agent-core';
import { parseServiceCatalog, setServiceCatalogForTests } from '../../config/services.js';
import {
  effectiveModelPrice,
  effectiveServicePrice,
  estimateTokenCostMicros,
  setPriceOverridesForTests,
  tokenPriceSnapshot,
  unitPriceSnapshot,
  imageCostMicros,
  maxImageCostMicros,
  maxServiceUnitCostMicros,
  modelPrice,
  serviceUnitCostMicros,
  tokenCostMicros,
  usdToMicros,
} from '../pricing.js';

afterEach(() => {
  setPriceOverridesForTests([]);
  setServiceCatalogForTests(null);
  setModelRegistry(DEFAULT_MODEL_REGISTRY);
});

describe('token pricing', () => {
  const price = { input: 0.28, output: 0.42, cachedInput: 0.028 };

  it('bills cached input at the cache price and the rest at the input price', () => {
    // 1000 uncached × 0.28 + 9000 cached × 0.028 + 500 × 0.42 = 280 + 252 + 210
    expect(tokenCostMicros(price, { inputTokens: 10_000, cachedInputTokens: 9_000, outputTokens: 500 })).toBe(742);
  });

  it('bills cached input at the input price when the model has no cache price', () => {
    expect(
      tokenCostMicros({ input: 1, output: 2 }, { inputTokens: 100, cachedInputTokens: 60, outputTokens: 10 }),
    ).toBe(120);
  });

  it('rounds the call up once, never a fraction of a micro down to free', () => {
    expect(tokenCostMicros({ input: 0.1, output: 0.1 }, { inputTokens: 1, outputTokens: 0 })).toBe(1);
  });

  it('caps cached tokens at the input count', () => {
    expect(tokenCostMicros(price, { inputTokens: 10, cachedInputTokens: 50, outputTokens: 0 })).toBe(1);
  });

  it('returns null (unpriced), not zero, without a price', () => {
    expect(tokenCostMicros(undefined, { inputTokens: 1_000, outputTokens: 1_000 })).toBeNull();
    expect(estimateTokenCostMicros(undefined, { inputTokens: 1, outputTokens: 1 })).toBeNull();
  });

  it('reserves every input token as uncached', () => {
    expect(estimateTokenCostMicros(price, { inputTokens: 10_000, outputTokens: 500 })).toBe(3_010);
  });

  it('finds a model price by catalog id or by the raw provider model', () => {
    setModelRegistry({
      flash: {
        name: 'Flash',
        price: { input: 1, output: 2 },
        providers: [{ provider: 'deepseek', model: 'deepseek-v9-flash', apiKeyEnv: 'K' }],
      },
      free: { name: 'Free', providers: [{ provider: 'deepseek', model: 'free-model', apiKeyEnv: 'K' }] },
    });
    expect(modelPrice(undefined, 'flash')).toEqual({ input: 1, output: 2 });
    expect(modelPrice('deepseek-v9-flash')).toEqual({ input: 1, output: 2 });
    expect(modelPrice('free-model')).toBeUndefined();
    expect(modelPrice('nobody-knows')).toBeUndefined();
  });
});

describe('service pricing', () => {
  it('discards float noise: $0.008 is 8000 micros, not 8001', () => {
    expect(usdToMicros(0.008)).toBe(8_000);
    expect(usdToMicros(0.005)).toBe(5_000);
  });

  it('prices calls from the shipped services.yaml', () => {
    expect(serviceUnitCostMicros('web_search', 'tavily', 1)).toBe(8_000);
    expect(serviceUnitCostMicros('web_search', 'brave', 2)).toBe(10_000);
    // Shipped without a price: unpriced, not free.
    expect(serviceUnitCostMicros('web_search', 'firecrawl', 1)).toBeNull();
    // Priced at zero: free, not unpriced.
    expect(serviceUnitCostMicros('page_read', 'jina', 1)).toBe(0);
  });

  it('reserves the dearest priced provider a call may fall through', () => {
    expect(maxServiceUnitCostMicros('web_search', ['tavily', 'firecrawl', 'brave'])).toBe(8_000);
    expect(maxServiceUnitCostMicros('web_search', ['firecrawl'])).toBeNull();
  });

  it('prices images by size, and by tokens when the provider declares and reports them', () => {
    expect(imageCostMicros({ provider: 'media', quality: 'low', size: '1024x1024' })).toBe(6_000);
    expect(imageCostMicros({ provider: 'media', quality: 'low', size: '1536x1024' })).toBe(5_000);
    expect(imageCostMicros({ provider: 'media', quality: 'high', size: '1024x1024' })).toBeNull();
    expect(maxImageCostMicros('media', 'low')).toBe(6_000);

    setServiceCatalogForTests(
      parseServiceCatalog(`
services:
  image_generation:
    unit: image
    providers:
      media:
        token_price: { input: 5, output: 30 }
        price_by_size: { low: { 1024x1024: 0.006 } }
`),
    );
    // 10 × 5 + 200 × 30 = 6050 micros when usage is reported…
    expect(
      imageCostMicros({
        provider: 'media',
        quality: 'low',
        size: '1024x1024',
        usage: { inputTokens: 10, outputTokens: 200 },
      }),
    ).toBe(6_050);
    // …and the size table when it is not.
    expect(imageCostMicros({ provider: 'media', quality: 'low', size: '1024x1024' })).toBe(6_000);
  });
});

describe('parseServiceCatalog', () => {
  it('parses the shipped file', () => {
    const catalog = parseServiceCatalog(
      readFileSync(resolve(import.meta.dirname, '../../config/services.yaml'), 'utf-8'),
    );
    expect(Object.keys(catalog).sort()).toEqual(['computer', 'image_generation', 'page_read', 'vision', 'web_search']);
    expect(catalog.computer?.enabled).toBe(false);
    expect(catalog.image_generation?.providers.media?.apiKeyEnv).toEqual([
      'IMAGE_API_KEY',
      'MEDIA_API_KEY',
      'LLM_API_KEY',
    ]);
  });

  it.each([
    ['services:\n  llm: { unit: token }\n', /unknown service "llm"/],
    ['services:\n  websearch: { unit: call }\n', /unknown service "websearch"/],
    ['services:\n  web_search: { unit: hour }\n', /unit must be one of/],
    ['services:\n  web_search:\n    unit: call\n    providers:\n      tavilly: { price: 1 }\n', /unknown provider/],
    ['services:\n  web_search:\n    unit: call\n    providers:\n      tavily: { price: -1 }\n', /non-negative/],
    ['services:\n  web_search:\n    unit: call\n    providers:\n      tavily: { cost: 1 }\n', /not a provider field/],
    ['services:\n  vision:\n    unit: token\n    providers:\n      media: { price: 1 }\n', /token_price/],
    [
      'services:\n  web_search:\n    unit: call\n    providers:\n      tavily: { price_by_size: { low: {} } }\n',
      /only applies to image/,
    ],
  ])('rejects %j', (source, error) => {
    expect(() => parseServiceCatalog(source)).toThrow(error);
  });
});

function override(row: {
  kind: 'model' | 'service';
  target: string;
  provider?: string;
  input?: number;
  output?: number;
  cached?: number;
  unit?: number;
}) {
  return {
    id: `upo_${row.kind}_${row.target}_${row.provider ?? ''}`,
    kind: row.kind,
    target: row.target,
    provider: row.provider ?? '',
    input_per_mtok: row.input ?? null,
    output_per_mtok: row.output ?? null,
    cached_input_per_mtok: row.cached ?? null,
    unit_price: row.unit ?? null,
    updated_by: null,
    created_at: '2026-10-24T00:00:00.000Z',
    updated_at: '2026-10-24T00:00:00.000Z',
  };
}

describe('admin price overrides', () => {
  it('prices an unpriced model and wins over the catalog price', () => {
    setModelRegistry({
      flash: { name: 'Flash', providers: [{ provider: 'deepseek', model: 'raw-flash', apiKeyEnv: 'K' }] },
      pro: {
        name: 'Pro',
        price: { input: 1, output: 2 },
        providers: [{ provider: 'deepseek', model: 'raw-pro', apiKeyEnv: 'K' }],
      },
    });
    expect(modelPrice('raw-flash')).toBeUndefined();
    setPriceOverridesForTests([
      override({ kind: 'model', target: 'flash', input: 0.3, output: 0.5, cached: 0.03 }),
      override({ kind: 'model', target: 'pro', input: 9, output: 9 }),
    ]);
    expect(effectiveModelPrice('raw-flash')).toEqual({
      price: { input: 0.3, output: 0.5, cachedInput: 0.03 },
      source: 'override',
      model: 'flash',
    });
    expect(effectiveModelPrice(undefined, 'pro')?.price).toEqual({ input: 9, output: 9 });
  });

  it('overrides a service unit price, and flattens an image size table', () => {
    setPriceOverridesForTests([
      override({ kind: 'service', target: 'web_search', provider: 'firecrawl', unit: 0.01 }),
      override({ kind: 'service', target: 'image_generation', provider: 'media', unit: 0.02 }),
      override({ kind: 'service', target: 'vision', provider: 'media', input: 0.15, output: 0.6 }),
    ]);
    expect(serviceUnitCostMicros('web_search', 'firecrawl', 1)).toBe(10_000);
    expect(serviceUnitCostMicros('web_search', 'tavily', 1)).toBe(8_000);
    expect(imageCostMicros({ provider: 'media', quality: 'low', size: '1024x1024' })).toBe(20_000);
    expect(maxImageCostMicros('media', 'low')).toBe(20_000);
    expect(effectiveServicePrice('vision', 'media')).toEqual({
      source: 'override',
      tokenPrice: { input: 0.15, output: 0.6 },
    });
  });

  it('snapshots the applied rate for the usage fact', () => {
    expect(tokenPriceSnapshot({ input: 1, output: 2 }, 'override', { model: 'flash' })).toEqual({
      source: 'override',
      input_per_mtok: 1,
      output_per_mtok: 2,
      cached_input_per_mtok: 1,
      model: 'flash',
    });
    expect(unitPriceSnapshot(0.008, 'config', { unit: 'call' })).toEqual({
      source: 'config',
      unit_price: 0.008,
      unit: 'call',
    });
  });
});
