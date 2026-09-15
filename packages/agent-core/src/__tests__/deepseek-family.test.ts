/**
 * DeepSeek behind the generic `openai-compatible` provider id.
 *
 * Regression (2026-09-15): the built-in `flash` id became an env-derived
 * `openai-compatible` entry. Built with @ai-sdk/openai, it forwarded only
 * `providerOptions.openai`, so the title generator's
 * `providerOptions.deepseek.thinking = disabled` never reached DeepSeek; V4
 * thought by default, the 60-token output budget went to reasoning, and every
 * new session was titled with the user's raw first message. The factory now
 * routes by model family / host, and buildProviderOptions agrees with it.
 */

import type { LanguageModelV3 } from '@ai-sdk/provider';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProviderOptions, createModelFromConfig, isDeepSeekFamily } from '../model.js';
import { DEFAULT_MODEL_REGISTRY, setModelRegistry, type ModelEntry } from '../registry.js';

const KEY_ENV = 'TEST_DEEPSEEK_FAMILY_KEY';

const REGISTRY: Record<string, ModelEntry> = {
  flash: {
    name: 'Default model (LLM_MODEL → DeepSeek)',
    providers: [
      {
        provider: 'openai-compatible',
        model: 'deepseek-v4-flash',
        apiKeyEnv: KEY_ENV,
        baseUrl: 'https://api.deepseek.com',
      },
    ],
  },
  generic: {
    name: 'Some other OpenAI-compatible endpoint',
    providers: [
      { provider: 'openai-compatible', model: 'gpt-4o-mini', apiKeyEnv: KEY_ENV, baseUrl: 'https://api.openai.com/v1' },
    ],
  },
  gateway: {
    name: 'Vendor-prefixed DeepSeek on a third-party gateway',
    providers: [
      {
        provider: 'openai-compatible',
        model: 'deepseek-ai/DeepSeek-V4',
        apiKeyEnv: KEY_ENV,
        baseUrl: 'https://api.siliconflow.cn/v1',
      },
    ],
  },
};

beforeAll(() => {
  setModelRegistry(REGISTRY);
  process.env[KEY_ENV] = 'test-key';
});
afterAll(() => {
  setModelRegistry(DEFAULT_MODEL_REGISTRY);
  delete process.env[KEY_ENV];
});

const config = (id: string, options?: ModelEntry['options']) => ({
  id,
  provider: 'openai-compatible',
  model: id,
  ...(options ? { options } : {}),
});

describe('isDeepSeekFamily', () => {
  it.each([
    ['deepseek-v4-flash', undefined, true],
    ['DeepSeek-Chat', 'https://relay.example.com/v1', true],
    ['gpt-4o', 'https://api.deepseek.com', true],
    ['gpt-4o', 'https://api.deepseek.com/beta', true],
    ['gpt-4o', 'https://api.openai.com/v1', false],
    ['deepseek-ai/DeepSeek-V4', 'https://api.siliconflow.cn/v1', false],
    ['gpt-4o', 'not a url', false],
    ['gpt-4o', undefined, false],
  ])('%s @ %s → %s', (model, baseUrl, expected) => {
    expect(isDeepSeekFamily(model, baseUrl)).toBe(expected);
  });
});

describe('createModelFromConfig', () => {
  it('builds a DeepSeek-backed openai-compatible entry with the DeepSeek client', async () => {
    const model = (await createModelFromConfig(config('flash'))) as LanguageModelV3;
    expect(model.provider).toMatch(/^deepseek/);
    expect(model.modelId).toBe('deepseek-v4-flash');
  });

  it('keeps every other endpoint on the generic OpenAI client', async () => {
    const generic = (await createModelFromConfig(config('generic'))) as LanguageModelV3;
    expect(generic.provider).toMatch(/^openai/);

    const gateway = (await createModelFromConfig(config('gateway'))) as LanguageModelV3;
    expect(gateway.provider).toMatch(/^openai/);
  });
});

describe('buildProviderOptions', () => {
  it('sends the DeepSeek thinking switch both ways for a DeepSeek-backed entry', () => {
    expect(buildProviderOptions(config('flash', { thinking: true }))).toEqual({
      deepseek: { thinking: { type: 'enabled' } },
    });
    expect(buildProviderOptions(config('flash', { thinking: false }))).toEqual({
      deepseek: { thinking: { type: 'disabled' } },
    });
    expect(buildProviderOptions(config('flash'))).toBeUndefined();
  });

  it('stays silent for endpoints that do not speak DeepSeek', () => {
    expect(buildProviderOptions(config('generic', { thinking: true }))).toBeUndefined();
    expect(buildProviderOptions(config('gateway', { thinking: true }))).toBeUndefined();
  });

  it('applies the same routing to a direct (non-registry) config', () => {
    expect(
      buildProviderOptions({
        provider: 'openai-compatible',
        model: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com',
        options: { thinking: false },
      }),
    ).toEqual({ deepseek: { thinking: { type: 'disabled' } } });
  });
});
