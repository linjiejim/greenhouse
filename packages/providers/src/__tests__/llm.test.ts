import { generateText } from 'ai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { describe, expect, it, vi } from 'vitest';
import { getAdapter } from '../registry.js';
import { pinnedFetch } from '../pinned-fetch.js';
import { isDeepSeekFamily, withAttempts, withFallback } from '../llm/models.js';
import type { LlmClient } from '../types.js';

const completion = (model: string) =>
  new Response(
    JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    }),
    { headers: { 'content-type': 'application/json' } },
  );

function compatibleClient(baseUrl: string, wire: ReturnType<typeof vi.fn>) {
  const adapter = getAdapter('llm', 'openai-compatible')!;
  const config = adapter.configSchema.parse({ baseUrl, defaultModel: 'deepseek-chat' });
  return adapter.create({
    config,
    secrets: { apiKey: 'sk-test' },
    fetch: pinnedFetch(adapter.endpoints(config), wire as unknown as typeof fetch),
  }) as LlmClient;
}

describe('LLM adapters', () => {
  it('sends the key only to the instance base URL', async () => {
    const wire = vi.fn(async () => completion('deepseek-chat'));
    const client = compatibleClient('https://api.deepseek.com', wire);
    const result = await generateText({ model: client.languageModel('deepseek-chat'), prompt: 'hi' });
    expect(result.text).toBe('OK');
    const [url, init] = wire.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).origin).toBe('https://api.deepseek.com');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-test');
  });

  it('routes DeepSeek models through the DeepSeek client and everything else through the generic one', () => {
    const wire = vi.fn();
    const client = compatibleClient('https://api.siliconflow.cn/v1', wire);
    expect(client.languageModel('deepseek-chat').provider).toContain('deepseek');
    expect(client.languageModel('Qwen/Qwen3-8B').provider).toContain('openai-compatible');
    expect(isDeepSeekFamily('deepseek-ai/DeepSeek-V4', 'https://api.siliconflow.cn/v1')).toBe(false);
    expect(isDeepSeekFamily('anything', 'https://api.deepseek.com')).toBe(true);
  });

  it('requires a base URL for OpenAI-compatible instances', () => {
    const adapter = getAdapter('llm', 'openai-compatible')!;
    expect(() => adapter.endpoints(adapter.configSchema.parse({}))).toThrow('base URL');
  });
});

function fakeModel(id: string, behaviour: () => Promise<never> | Promise<unknown>): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: id,
    modelId: id,
    supportedUrls: {},
    doGenerate: behaviour as LanguageModelV4['doGenerate'],
    doStream: behaviour as LanguageModelV4['doStream'],
  };
}

describe('model wrappers', () => {
  it('falls back on retriable errors only', async () => {
    const busy = Object.assign(new Error('busy'), { statusCode: 429 });
    const second = vi.fn(async () => ({ ok: 'second' }));
    const chain = withFallback([fakeModel('a', async () => Promise.reject(busy)), fakeModel('b', second)]);
    await expect(chain.doGenerate({} as never)).resolves.toEqual({ ok: 'second' });

    const bad = Object.assign(new Error('bad request'), { statusCode: 400 });
    const untouched = vi.fn();
    const strict = withFallback([fakeModel('a', async () => Promise.reject(bad)), fakeModel('b', untouched)]);
    await expect(strict.doGenerate({} as never)).rejects.toThrow('bad request');
    expect(untouched).not.toHaveBeenCalled();
  });

  it('opens a lease per attempt, caps output and settles usage', async () => {
    const seen: unknown[] = [];
    const inner = fakeModel('a', async () => ({
      usage: { inputTokens: { total: 7, cacheRead: 2 }, outputTokens: { total: 3, reasoning: 0 } },
    }));
    const original = inner.doGenerate;
    inner.doGenerate = async (options) => {
      seen.push(options.maxOutputTokens);
      return original(options);
    };
    const settled: unknown[] = [];
    const started = vi.fn();
    const model = withAttempts(inner, 'corp-deepseek', async () => ({
      started,
      settle: async (usage) => void settled.push(usage),
    }));
    await model.doGenerate({ prompt: [] } as never);
    expect(seen).toEqual([20_000]);
    expect(started).toHaveBeenCalledOnce();
    expect(settled).toEqual([{ inputTokens: 7, outputTokens: 3, cachedInputTokens: 2, reasoningTokens: 0 }]);
  });
});
