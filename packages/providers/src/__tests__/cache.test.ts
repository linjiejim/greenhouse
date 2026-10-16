import { generateText } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { CACHE_BREAKPOINT } from '../llm/cache.js';
import { pinnedFetch } from '../pinned-fetch.js';
import { getAdapter } from '../registry.js';
import type { LlmClient } from '../types.js';

const message = () =>
  new Response(
    JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [{ type: 'text', text: 'OK' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 1200 },
    }),
    { headers: { 'content-type': 'application/json' } },
  );

const completion = () =>
  new Response(
    JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    }),
    { headers: { 'content-type': 'application/json' } },
  );

function client(kind: string, config: Record<string, unknown>, wire: ReturnType<typeof vi.fn>) {
  const adapter = getAdapter('llm', kind)!;
  const parsed = adapter.configSchema.parse(config);
  return adapter.create({
    config: parsed,
    secrets: { apiKey: 'sk-test' },
    fetch: pinnedFetch(adapter.endpoints(parsed), wire as unknown as typeof fetch),
  }) as LlmClient;
}

const prompt = {
  instructions: { role: 'system' as const, content: 'You are an Agent.', providerOptions: CACHE_BREAKPOINT },
  messages: [
    { role: 'user' as const, content: 'first', providerOptions: CACHE_BREAKPOINT },
    { role: 'assistant' as const, content: 'answer' },
    { role: 'user' as const, content: 'second', providerOptions: CACHE_BREAKPOINT },
  ],
};

describe('prompt cache breakpoints', () => {
  it('become cache_control on the marked blocks of an Anthropic request, and nothing else', async () => {
    const wire = vi.fn(async () => message());
    const model = client('anthropic', { defaultModel: 'claude-test' }, wire).languageModel('claude-test');
    const result = await generateText({ model, ...prompt, maxOutputTokens: 5 });
    expect(result.usage.inputTokenDetails.cacheReadTokens).toBe(1200);
    const body = JSON.parse(String((wire.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.system).toEqual([{ type: 'text', text: 'You are an Agent.', cache_control: { type: 'ephemeral' } }]);
    const marks = body.messages.map((entry: { content: Array<{ cache_control?: unknown }> }) =>
      entry.content.map((part) => part.cache_control ?? null),
    );
    expect(marks).toEqual([[{ type: 'ephemeral' }], [null], [{ type: 'ephemeral' }]]);
    expect(JSON.stringify(body)).not.toContain('greenhouse');
  });

  it('leave an OpenAI-compatible request as it was: those services cache a repeated prefix themselves', async () => {
    const wire = vi.fn(async () => completion());
    const model = client(
      'openai-compatible',
      { baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat' },
      wire,
    ).languageModel('deepseek-chat');
    await generateText({ model, ...prompt, maxOutputTokens: 5 });
    const body = String((wire.mock.calls[0] as unknown as [string, RequestInit])[1].body);
    expect(body).not.toContain('cache_control');
    expect(body).not.toContain('greenhouse');
  });
});
