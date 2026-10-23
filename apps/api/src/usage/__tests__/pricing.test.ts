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
  estimateTokenCostMicros,
  imageCostMicros,
  maxImageCostMicros,
  maxServiceUnitCostMicros,
  modelPrice,
  serviceUnitCostMicros,
  tokenCostMicros,
  usdToMicros,
} from '../pricing.js';

afterEach(() => {
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
