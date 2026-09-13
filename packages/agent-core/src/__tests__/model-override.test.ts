/**
 * Regression tests for the model_override resolution path.
 *
 * Original bug (audit 2026-06-10 defect #4): the fast/slow-thinking toggle only
 * set `config.model`, but all profiles resolve through the registry (`config.id`),
 * so the override was silently ignored and usage was recorded against the
 * never-running model.
 */

import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { applyModelOverride, buildProviderOptions, createModelFromConfig } from '../model.js';
import {
  findModelIdByProviderModel,
  DEFAULT_MODEL_REGISTRY,
  setModelRegistry,
  modelSupportsVision,
  type ModelEntry,
} from '../registry.js';
import type { ModelConfig } from '../model.js';

// The built-in registry is env-derived (any OpenAI-compatible endpoint); these
// cases need concrete DeepSeek ids to exercise the raw-model-string path.
const TEST_REGISTRY: Record<string, ModelEntry> = {
  flash: {
    name: 'DeepSeek V4 Flash',
    providers: [{ provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnv: 'DEEPSEEK_API_KEY' }],
  },
  pro: {
    name: 'DeepSeek V4 Pro',
    providers: [{ provider: 'deepseek', model: 'deepseek-v4-pro', apiKeyEnv: 'DEEPSEEK_API_KEY' }],
  },
};

beforeAll(() => setModelRegistry(TEST_REGISTRY));
afterAll(() => setModelRegistry(DEFAULT_MODEL_REGISTRY));

const profileConfig: ModelConfig = {
  id: 'flash',
  provider: 'deepseek',
  model: 'flash', // placeholder filled by profile loader
  options: { thinking: true, temperature: 0.4, max_tokens: 20000 },
};

describe('findModelIdByProviderModel', () => {
  it('maps a raw provider model string back to its registry id', () => {
    expect(findModelIdByProviderModel('deepseek-v4-pro')).toBe('pro');
    expect(findModelIdByProviderModel('deepseek-v4-flash')).toBe('flash');
  });

  it('returns undefined for unknown model strings', () => {
    expect(findModelIdByProviderModel('gpt-4o')).toBeUndefined();
  });
});

describe('applyModelOverride', () => {
  it('rewrites the registry id when the override is a raw provider model (the original bug)', () => {
    const result = applyModelOverride(profileConfig, 'deepseek-v4-pro');
    expect(result.id).toBe('pro'); // registry path now resolves the override
    expect(result.provider).toBe('deepseek'); // DSML interception stays active
    expect(result.model).toBe('deepseek-v4-pro'); // usage records the running model
  });

  it('accepts a logical registry id directly', () => {
    const result = applyModelOverride(profileConfig, 'pro');
    expect(result.id).toBe('pro');
    expect(result.model).toBe(TEST_REGISTRY.pro.providers[0].model);
  });

  it('falls through to the direct provider+model path for unknown models', () => {
    const result = applyModelOverride(profileConfig, 'gpt-4o');
    expect(result.id).toBeUndefined(); // direct path — registry no longer shadows it
    expect(result.model).toBe('gpt-4o');
  });

  it('does not mutate the profile config and keeps profile options', () => {
    const result = applyModelOverride(profileConfig, 'deepseek-v4-pro');
    expect(profileConfig.id).toBe('flash');
    expect(profileConfig.model).toBe('flash');
    expect(result.options).toEqual(profileConfig.options);
  });
});

describe('attributed model id', () => {
  // `messages.model` renders on the assistant bubble next to the picker, so the
  // two have to speak the same vocabulary. `modelConfig.model` is the PRIMARY
  // provider's upstream name and does not change when the chain falls through
  // to a backup — recording it would name a provider that never ran.
  it('is the registry id, not the primary provider\u2019s upstream name', () => {
    const resolved = applyModelOverride(profileConfig, 'pro');
    expect(resolved.id ?? resolved.model).toBe('pro');
    expect(resolved.model).toBe('deepseek-v4-pro'); // the value we deliberately do NOT store
  });

  it('falls back to the raw name when the model is off-catalog', () => {
    const resolved = applyModelOverride(profileConfig, 'gpt-4o');
    expect(resolved.id ?? resolved.model).toBe('gpt-4o');
  });
});

describe('supported providers', () => {
  it('rejects removed provider implementations and lists only wired providers', async () => {
    await expect(createModelFromConfig({ provider: 'google', model: 'gemini' })).rejects.toThrow(
      'Supported: deepseek, openai, kimi, minimax, openai-compatible',
    );
  });

  it('builds thinking options only for DeepSeek', () => {
    expect(buildProviderOptions(profileConfig)).toEqual({ deepseek: { thinking: { type: 'enabled' } } });
    expect(
      buildProviderOptions({
        provider: 'openai',
        model: 'gpt-4o',
        options: { thinking: true },
      }),
    ).toBeUndefined();
  });
});

describe('minimax provider', () => {
  const minimaxConfig: ModelConfig = { provider: 'minimax', model: 'MiniMax-M3' };

  it('creates a model without needing LLM_BASE_URL (its endpoint is built in)', async () => {
    const model = await createModelFromConfig(minimaxConfig);
    expect(model).toMatchObject({ modelId: 'MiniMax-M3' });
  });

  it('admits every concrete provider attempt before I/O and supplies a hard output cap', async () => {
    const marked = vi.fn();
    const settle = vi.fn();
    const hook = vi.fn().mockResolvedValue({ markProviderIoStarted: marked, settle });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch;
    try {
      const model = (await createModelFromConfig(
        { ...minimaxConfig, apiKey: 'MINIMAX_API_KEY' },
        { onProviderAttempt: hook },
      )) as unknown as { doStream: (options: unknown) => Promise<unknown> };
      await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(hook).toHaveBeenCalledWith({
      descriptor: expect.objectContaining({
        provider: 'minimax',
        modelId: 'MiniMax-M3',
        scopeId: 'MINIMAX_API_KEY:minimax:default',
      }),
      options: expect.objectContaining({ maxOutputTokens: 20_000 }),
    });
    expect(marked).toHaveBeenCalledOnce();
  });

  it('always asks for split reasoning; a thinking switch only when explicitly off', () => {
    // reasoning_split moves thinking from inline <think> tags in `content`
    // into the reasoning_content field the client actually parses.
    expect(buildProviderOptions(minimaxConfig)).toEqual({ minimax: { reasoning_split: true } });
    expect(buildProviderOptions({ ...minimaxConfig, options: { thinking: true } })).toEqual({
      minimax: { reasoning_split: true },
    });
    expect(buildProviderOptions({ ...minimaxConfig, options: { thinking: false } })).toEqual({
      minimax: { reasoning_split: true, thinking: { type: 'disabled' } },
    });
  });

  // Wire-format contract, mirroring the kimi test: `include_usage` keeps
  // streamed answers billable, and the namespace has to match the client name
  // or reasoning_split silently never reaches the body.
  it('asks for usage on streams and puts reasoning_split in the body', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    const savedKey = process.env.MINIMAX_API_KEY;
    process.env.MINIMAX_API_KEY = 'sk-cp-unit-test';
    globalThis.fetch = (async (_url: unknown, init: { body?: string }) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;

    try {
      const model = (await createModelFromConfig({ ...minimaxConfig, apiKey: 'MINIMAX_API_KEY' })) as unknown as {
        doStream: (o: unknown) => Promise<unknown>;
      };
      await model.doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        providerOptions: buildProviderOptions(minimaxConfig),
      });
    } finally {
      globalThis.fetch = realFetch;
      if (savedKey === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = savedKey;
    }

    expect(sent[0]).toMatchObject({
      model: 'MiniMax-M3',
      stream_options: { include_usage: true },
      reasoning_split: true,
    });
  });
});

describe('modelSupportsVision', () => {
  it('is true only for catalog entries that declare vision (fail closed)', () => {
    try {
      setModelRegistry({
        ...TEST_REGISTRY,
        'vision-model': {
          name: 'Vision Model',
          vision: true,
          providers: [{ provider: 'minimax', model: 'MiniMax-M3', apiKeyEnv: 'MINIMAX_API_KEY' }],
        },
      });
      expect(modelSupportsVision('vision-model')).toBe(true);
      expect(modelSupportsVision('flash')).toBe(false); // no declaration → text-only
      expect(modelSupportsVision('no-such-model')).toBe(false);
      expect(modelSupportsVision(undefined)).toBe(false);
    } finally {
      setModelRegistry(TEST_REGISTRY);
    }
  });
});

describe('kimi provider', () => {
  const kimiConfig: ModelConfig = { provider: 'kimi', model: 'k3' };

  it('creates a model without needing LLM_BASE_URL (its endpoint is built in)', async () => {
    const model = await createModelFromConfig(kimiConfig);
    expect(model).toMatchObject({ modelId: 'k3' });
  });

  it('sends reasoning_effort under Kimi’s own namespace — the only reasoning knob it honours', () => {
    // The namespace is the provider name we construct the client with, so the
    // options land on the wire as `reasoning_effort` for kimi and nothing else.
    for (const effort of ['low', 'high', 'max'] as const) {
      expect(buildProviderOptions({ ...kimiConfig, options: { reasoning_effort: effort } })).toEqual({
        kimi: { reasoningEffort: effort },
      });
    }
  });

  it('never sends a thinking switch: K3 reasons unconditionally', () => {
    expect(buildProviderOptions({ ...kimiConfig, options: { thinking: true } })).toBeUndefined();
    expect(buildProviderOptions(kimiConfig)).toBeUndefined();
  });

  // What actually goes on the wire. Both facts below were found the hard way
  // against the live endpoint: without `include_usage` a streamed answer bills
  // zero tokens against every quota, and the provider-options namespace has to
  // match the client's `name` or `reasoning_effort` is silently dropped.
  it('asks for usage on streams and puts reasoning_effort in the body', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    const savedKey = process.env.KIMI_API_KEY;
    process.env.KIMI_API_KEY = 'sk-unit-test';
    globalThis.fetch = (async (_url: unknown, init: { body?: string }) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;

    try {
      // `LanguageModel` is a union that includes a bare model-id string, so it
      // needs the two-step cast to reach the wire call.
      const model = (await createModelFromConfig({ ...kimiConfig, apiKey: 'KIMI_API_KEY' })) as unknown as {
        doStream: (o: unknown) => Promise<unknown>;
      };
      await model.doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        providerOptions: buildProviderOptions({ ...kimiConfig, options: { reasoning_effort: 'high' } }),
      });
    } finally {
      globalThis.fetch = realFetch;
      if (savedKey === undefined) delete process.env.KIMI_API_KEY;
      else process.env.KIMI_API_KEY = savedKey;
    }

    expect(sent[0]).toMatchObject({
      model: 'k3',
      stream_options: { include_usage: true },
      reasoning_effort: 'high',
    });
    // Kimi 400s on any sampling value but its own — we must send none of them.
    for (const banned of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty']) {
      expect(sent[0]![banned], banned).toBeUndefined();
    }
  });
});
