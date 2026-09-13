/**
 * Regression test for the DSML interceptor gate (resolvesToDeepSeek).
 *
 * Bug: the interceptor wrapped only when `modelConfig.provider === 'deepseek'`.
 * The default profiles resolve through the registry (`id: flash`) and the loader
 * produces a config WITHOUT `provider`, so interception was silently skipped and
 * raw DSML tool-call markup leaked into answers (e2e 2026-06-24).
 */

import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { resolvesToDeepSeek } from '../model.js';
import type { ModelConfig } from '../model.js';
import { DEFAULT_MODEL_REGISTRY, setModelRegistry } from '../registry.js';

// The built-in registry points at whatever OpenAI-compatible endpoint the env
// names; the gate under test only matters once the catalog resolves to DeepSeek.
beforeAll(() =>
  setModelRegistry({
    flash: {
      name: 'DeepSeek V4 Flash',
      providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnv: 'DEEPSEEK_API_KEY' }],
    },
    pro: {
      name: 'DeepSeek V4 Pro',
      providers: [{ provider: 'deepseek', model: 'deepseek-v4-pro', apiKeyEnv: 'DEEPSEEK_API_KEY' }],
    },
  }),
);
afterAll(() => setModelRegistry(DEFAULT_MODEL_REGISTRY));

describe('resolvesToDeepSeek (DSML interceptor gate)', () => {
  it('registry id WITHOUT provider (the bug) → true for DeepSeek models', () => {
    // Exactly what the default profile loader produces for `model: { id: flash }`.
    expect(resolvesToDeepSeek({ id: 'flash', options: { thinking: true } } as ModelConfig)).toBe(true);
    expect(resolvesToDeepSeek({ id: 'pro' } as ModelConfig)).toBe(true);
  });

  it('direct provider config', () => {
    expect(resolvesToDeepSeek({ provider: 'deepseek', model: 'deepseek-v4-flash' } as ModelConfig)).toBe(true);
    expect(resolvesToDeepSeek({ provider: 'openai', model: 'gpt-4o' } as ModelConfig)).toBe(false);
    // An openai-compatible transport serving a DeepSeek model still leaks DSML.
    expect(resolvesToDeepSeek({ provider: 'openai-compatible', model: 'deepseek-v4-0324' } as ModelConfig)).toBe(true);
  });

  it('unknown id / empty config → false (no false positives)', () => {
    expect(resolvesToDeepSeek({ id: 'nonexistent' } as ModelConfig)).toBe(false);
    expect(resolvesToDeepSeek({} as ModelConfig)).toBe(false);
  });
});
