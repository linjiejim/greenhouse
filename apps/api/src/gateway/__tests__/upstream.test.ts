import { describe, expect, it } from 'vitest';
import type { ModelEntry } from '@greenhouse/agent-core';
import {
  anthropicUpstreamHeaders,
  anthropicUsage,
  buildUpstreamBody,
  validateMessagesRequest,
  estimateCallTokens,
  GatewayRequestError,
  listGatewayModels,
  parseUsage,
  readUpstreamError,
  resolveGatewayModel,
  sanitizeUpstreamText,
  SseUsageRelay,
  upstreamChatUrl,
  upstreamHeaders,
  validateChatRequest,
} from '../upstream.js';

const env = { LLM_API_KEY: 'sk-upstream-secret-123456', LLM_BASE_URL: 'https://llm.internal.example/v1' };

const models: Record<string, ModelEntry> = {
  flash: {
    name: 'Default model',
    contextWindow: 64_000,
    options: { max_tokens: 8_000 },
    providers: [{ provider: 'openai-compatible', model: 'vendor-flash', apiKeyEnv: 'LLM_API_KEY' }],
  },
  ds: {
    name: 'DeepSeek',
    providers: [{ provider: 'deepseek', model: 'deepseek-flash', apiKeyEnv: 'DEEPSEEK_API_KEY' }],
  },
  odd: {
    name: 'Not OpenAI wire',
    providers: [{ provider: 'anthropic', model: 'x', apiKeyEnv: 'LLM_API_KEY' }],
  },
};

describe('model resolution', () => {
  it('resolves a catalog model to its first reachable OpenAI-wire upstream', () => {
    const model = resolveGatewayModel('flash', models.flash!, env);
    expect(model).toMatchObject({
      id: 'flash',
      upstreamModel: 'vendor-flash',
      baseUrl: env.LLM_BASE_URL,
      apiKey: env.LLM_API_KEY,
      scopeId: 'LLM_API_KEY:openai-compatible:default',
      contextWindow: 64_000,
      maxTokens: 8_000,
    });
    expect(resolveGatewayModel('ds', models.ds!, env)).toBeNull(); // key unset
    expect(resolveGatewayModel('ds', models.ds!, { DEEPSEEK_API_KEY: 'k' })?.baseUrl).toBe('https://api.deepseek.com');
    expect(resolveGatewayModel('odd', models.odd!, env)).toBeNull();
  });

  it('narrows to a key’s allow-list', () => {
    expect(listGatewayModels(models, null, env).map((m) => m.id)).toEqual(['flash']);
    expect(listGatewayModels(models, ['ds'], { ...env, DEEPSEEK_API_KEY: 'k' }).map((m) => m.id)).toEqual(['ds']);
    expect(listGatewayModels(models, [], env)).toEqual([]);
  });

  it('builds the upstream URL and headers from the upstream key only', () => {
    expect(upstreamChatUrl('https://x.example/v1/')).toBe('https://x.example/v1/chat/completions');
    expect(upstreamHeaders('sk-up', true)).toEqual({
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: 'Bearer sk-up',
    });
  });
});

describe('request', () => {
  it('validates the fields the gateway relies on', () => {
    expect(() => validateChatRequest({ messages: [{}] })).toThrow(GatewayRequestError);
    expect(() => validateChatRequest({ model: 'flash', messages: [] })).toThrow(/messages/);
    expect(() => validateChatRequest({ model: 'flash', messages: [{}], stream: 'yes' })).toThrow(/stream/);
    expect(() => validateChatRequest({ model: 'flash', messages: [{}], max_tokens: 0 })).toThrow(/max_tokens/);
    expect(() => validateChatRequest({ model: 'flash', messages: [{}], n: 99 })).toThrow(/n may be/);
    expect(
      validateChatRequest({
        model: ' flash ',
        messages: [{}],
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: 50,
        n: 2,
      }),
    ).toEqual({ model: 'flash', stream: true, clientWantsUsage: true, requestedOutputTokens: 50, choices: 2 });
  });

  it('swaps in the upstream model and forces usage on streams, passing tools and response_format through', () => {
    const tools = [{ type: 'function', function: { name: 'f', parameters: {} } }];
    const body = {
      model: 'flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { foo: 1 },
      tools,
      tool_choice: 'auto',
      response_format: { type: 'json_object' },
    };
    expect(buildUpstreamBody(body, 'vendor-flash')).toEqual({
      ...body,
      model: 'vendor-flash',
      stream_options: { foo: 1, include_usage: true },
    });
    expect(buildUpstreamBody({ model: 'flash', messages: [] }, 'v')).toEqual({ model: 'v', messages: [] });
  });

  it('estimates images per image and bounds output by the window', () => {
    const image = `data:image/png;base64,${'A'.repeat(200_000)}`;
    const body = {
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }] }],
    };
    const estimate = estimateCallTokens(
      body,
      { requestedOutputTokens: null, choices: 1 },
      { contextWindow: 10_000, maxTokens: null },
    );
    expect(estimate.inputTokens).toBeGreaterThan(1_500);
    expect(estimate.inputTokens).toBeLessThan(2_000);
    expect(estimate.outputTokens).toBe(10_000);
    expect(
      estimateCallTokens(body, { requestedOutputTokens: 100, choices: 3 }, { contextWindow: null, maxTokens: 8_000 })
        .outputTokens,
    ).toBe(300);
  });
});

describe('usage', () => {
  it('reads OpenAI and DeepSeek usage', () => {
    expect(
      parseUsage({
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 4 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 5, cachedTokens: 4, reasoningTokens: 2 });
    expect(parseUsage({ usage: { prompt_tokens: 7, completion_tokens: 1, prompt_cache_hit_tokens: 3 } })).toMatchObject(
      { cachedTokens: 3 },
    );
    expect(parseUsage({ usage: null })).toBeNull();
    expect(parseUsage({})).toBeNull();
  });

  it('relays SSE events as they complete and keeps the final usage', () => {
    const relay = new SseUsageRelay(true);
    const delta = 'data: {"choices":[{"delta":{"content":"he"}}],"usage":null}\n\n';
    const usage = 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n';
    expect(relay.push(delta.slice(0, 20))).toBe('');
    expect(relay.push(delta.slice(20))).toBe(delta);
    // The usage-only chunk is dropped for a client that did not ask for it.
    expect(relay.push(usage + 'data: [DONE]\n\n')).toBe('data: [DONE]\n\n');
    expect(relay.usage).toEqual({ inputTokens: 3, outputTokens: 2, cachedTokens: 0, reasoningTokens: 0 });
    expect(relay.sawDone).toBe(true);
    expect(relay.completed).toBe(true);

    // No [DONE], but a finished choice and the final usage: complete. A delta alone: not.
    const noDone = new SseUsageRelay(true);
    noDone.push(delta);
    expect(noDone.completed).toBe(false);
    noDone.push('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":null}\n\n' + usage);
    expect(noDone.completed).toBe(true);

    const sanitizing = new SseUsageRelay(true, (text) => text.replace('secret-host', '[redacted]'));
    const relayed = sanitizing.push('data: {"error":{"message":"overloaded at secret-host","code":"busy"}}\n\n');
    expect(relayed).toContain('[redacted]');
    expect(relayed).not.toContain('secret-host');
    expect(JSON.parse(relayed.slice(6))).toMatchObject({ error: { code: 'busy', type: 'api_error' } });

    const keep = new SseUsageRelay(false);
    expect(keep.push(usage)).toBe(usage);
    expect(keep.push(': keepalive\r\n\r\n')).toBe(': keepalive\r\n\r\n');
    expect(keep.push('data: {"x":1}')).toBe('');
    expect(keep.flush()).toBe('data: {"x":1}\n\n');
  });

  it('ends a flushed tail on an event boundary: whole events terminated, cut-offs and comments dropped', () => {
    const tail = (wire: 'openai' | 'anthropic', text: string) => {
      const relay = new SseUsageRelay(false, (value) => value, wire);
      relay.push(text);
      return relay.flush();
    };
    expect(tail('openai', 'data: {"choices":[]}')).toBe('data: {"choices":[]}\n\n');
    expect(tail('openai', 'data: [DONE]\n')).toBe('data: [DONE]\n\n');
    expect(tail('openai', 'data: {"choi')).toBe('');
    expect(tail('openai', ': keepalive')).toBe('');
    expect(tail('anthropic', 'event: ping\ndata: {"type":"ping"}')).toBe('event: ping\ndata: {"type":"ping"}\n\n');
    expect(tail('anthropic', 'event: content_block_delta')).toBe('');
  });
});

describe('upstream errors', () => {
  it('never lets an upstream key or URL through', () => {
    const model = { apiKey: env.LLM_API_KEY, baseUrl: env.LLM_BASE_URL };
    const text = sanitizeUpstreamText(
      `Incorrect API key ${env.LLM_API_KEY} for https://llm.internal.example/v1/chat (host llm.internal.example) Bearer abc.def sk-other-1234567`,
      model,
    );
    expect(text).not.toContain(env.LLM_API_KEY);
    expect(text).not.toContain('llm.internal.example');
    expect(text).not.toContain('sk-other');
    expect(text).not.toContain('abc.def');
    expect(sanitizeUpstreamText('x'.repeat(900), model).length).toBeLessThanOrEqual(501);
  });

  it('reads the OpenAI error shape', () => {
    expect(readUpstreamError('{"error":{"message":"bad tools","type":"invalid_request_error","code":"bad"}}')).toEqual({
      message: 'bad tools',
      type: 'invalid_request_error',
      code: 'bad',
    });
    expect(readUpstreamError('plain')).toEqual({ message: 'plain', type: null, code: null });
  });
});

describe('Anthropic wire', () => {
  const entry: ModelEntry = {
    name: 'DS',
    providers: [
      { provider: 'deepseek', model: 'ds-m', apiKeyEnv: 'K', anthropicBaseUrl: 'https://api.deepseek.com/anthropic' },
    ],
  };

  it('resolves only providers that declare an Anthropic endpoint', () => {
    expect(resolveGatewayModel('ds', entry, { K: 'k' }, 'anthropic')).toMatchObject({
      provider: 'anthropic',
      baseUrl: 'https://api.deepseek.com/anthropic',
      upstreamModel: 'ds-m',
      scopeId: 'K:anthropic:https://api.deepseek.com/anthropic',
    });
    expect(resolveGatewayModel('flash', models.flash!, env, 'anthropic')).toBeNull();
    expect(resolveGatewayModel('ds', entry, {}, 'anthropic')).toBeNull();
  });

  it('sends the upstream key as x-api-key and only protocol headers from the client', () => {
    expect(anthropicUpstreamHeaders('sk-up', false, { version: null, beta: 'a-1,b-2' })).toEqual({
      'content-type': 'application/json',
      accept: 'application/json',
      'x-api-key': 'sk-up',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'a-1,b-2',
    });
    expect(anthropicUpstreamHeaders('sk-up', true, { beta: 'bad\nheader' })['anthropic-beta']).toBeUndefined();
  });

  it('counts cache reads and writes as input, cache reads as cached', () => {
    expect(
      anthropicUsage(
        { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 2, output_tokens: 1 },
        { output_tokens: 8 },
      ),
    ).toEqual({ inputTokens: 16, outputTokens: 8, cachedTokens: 4, reasoningTokens: 0 });
    expect(anthropicUsage({})).toBeNull();
  });

  it('requires max_tokens on Messages', () => {
    expect(() => validateMessagesRequest({ model: 'ds', messages: [{}] })).toThrow(/max_tokens/);
    expect(validateMessagesRequest({ model: 'ds', messages: [{}], max_tokens: 10, stream: true })).toMatchObject({
      stream: true,
      requestedOutputTokens: 10,
    });
  });

  it('relays Messages events untouched and settles only after message_delta', () => {
    const relay = new SseUsageRelay(false, (text) => text, 'anthropic');
    const start =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n';
    expect(relay.push(start)).toBe(start);
    expect(relay.usage).toBeNull();
    const delta = 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n';
    expect(relay.push(delta)).toBe(delta);
    expect(relay.usage).toEqual({ inputTokens: 5, outputTokens: 7, cachedTokens: 0, reasoningTokens: 0 });
  });
});
