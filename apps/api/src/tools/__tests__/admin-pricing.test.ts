/**
 * Tests for the admin analytics cost estimator. These lock the token→USD math
 * and the "unknown model → null (not $0)" contract that keeps unpriced usage from
 * silently reading as free.
 */

import { describe, it, expect } from 'vitest';
import { estimateCostUsd, priceForModel } from '../admin/pricing.js';

describe('priceForModel — longest-substring match', () => {
  it('prefers the most specific family key', () => {
    // 'claude-haiku' must win over a hypothetical bare 'claude' — haiku is cheaper.
    expect(priceForModel('claude-haiku-4-5')?.output).toBe(4);
    expect(priceForModel('gpt-4o-mini')?.input).toBe(0.15);
    expect(priceForModel('gpt-4o-2024-11-20')?.input).toBe(2.5);
  });

  it('returns null for an unknown model', () => {
    expect(priceForModel('some-local-llama')).toBeNull();
  });
});

describe('estimateCostUsd', () => {
  it('sums input/output/cached/reasoning at their respective rates', () => {
    // gpt-4o: input 2.5, output 10, cached 1.25 (per 1e6). reasoning billed at output.
    // 1e6 input=2.5, 1e6 output=10, 1e6 cached=1.25, 1e6 reasoning=10 → 23.75
    const cost = estimateCostUsd('gpt-4o', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cached_tokens: 1_000_000,
      reasoning_tokens: 1_000_000,
    });
    expect(cost).toBe(23.75);
  });

  it('treats missing token fields as zero', () => {
    expect(estimateCostUsd('gpt-4o', { output_tokens: 500_000 })).toBe(5);
  });

  it('returns null (not 0) for an unknown model so it can be flagged as unpriced', () => {
    expect(estimateCostUsd('mystery-model', { input_tokens: 1_000_000 })).toBeNull();
  });

  it('rounds to 4 decimals', () => {
    // 1234 output tokens on gpt-4o = 1234/1e6 * 10 = 0.01234
    expect(estimateCostUsd('gpt-4o', { output_tokens: 1234 })).toBe(0.0123);
  });
});
