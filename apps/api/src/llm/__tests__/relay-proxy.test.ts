/**
 * Tests for the LLM Gateway relay pure helpers.
 */

import { describe, it, expect } from 'vitest';
import type { ModelEntry } from '@greenhouse/agent-core';
import {
  resolveModelSubset,
  resolveRelayModel,
  parseAllowedModels,
  isPassthroughKind,
  upstreamChatUrl,
  upstreamHeaders,
  buildUpstreamBody,
  extractUsageFromJson,
  extractUsageFromSseChunk,
  toModelsListResponse,
  buildRelayBudgetAttempt,
  applyRelayOutputLimit,
  type RelayModel,
} from '../relay-proxy.js';

describe('relay budget attempt identity', () => {
  it('keeps the client idempotency key as metadata while every provider attempt stays unique', () => {
    const first = buildRelayBudgetAttempt('client-1', 'business-operation-7', 'server-attempt-a');
    const replay = buildRelayBudgetAttempt('client-1', 'business-operation-7', 'server-attempt-b');

    expect(first.idempotencyKey).toBe('relay:client-1:server-attempt-a');
    expect(replay.idempotencyKey).toBe('relay:client-1:server-attempt-b');
    expect(first.idempotencyKey).not.toContain('business-operation-7');
    expect(first.metadata).toEqual({ client_idempotency_key: 'business-operation-7' });
    expect(replay.metadata).toEqual(first.metadata);
  });
});

describe('resolveModelSubset', () => {
  const catalog = ['a', 'b', 'c'];
  const publicIds = ['a', 'c'];

  it('falls back to the config public subset when the key has no allowlist', () => {
    expect(resolveModelSubset(null, catalog, publicIds)).toEqual(['a', 'c']);
    expect(resolveModelSubset([], catalog, publicIds)).toEqual(['a', 'c']);
  });

  it('restricts to the explicit allowlist (including models outside the public subset)', () => {
    expect(resolveModelSubset(['b'], catalog, publicIds)).toEqual(['b']);
  });

  it('ignores allowlist entries that are not in the catalog', () => {
    expect(resolveModelSubset(['a', 'ghost'], catalog, publicIds)).toEqual(['a']);
  });
});

describe('resolveRelayModel', () => {
  const entry: ModelEntry = {
    name: 'Flash',
    providers: [
      { provider: 'deepseek', model: 'v4-flash', apiKeyEnv: 'PRIMARY_KEY' },
      { provider: 'openai-compatible', model: 'alt', apiKeyEnv: 'FALLBACK_KEY', baseUrl: 'https://alt/v1' },
    ],
  };

  it('picks the first provider whose key env is set', () => {
    const resolved = resolveRelayModel('flash', entry, { PRIMARY_KEY: 'k1', FALLBACK_KEY: 'k2' } as NodeJS.ProcessEnv);
    expect(resolved).toMatchObject({
      id: 'flash',
      provider: 'deepseek',
      upstreamModel: 'v4-flash',
      apiKey: 'k1',
      scopeId: 'PRIMARY_KEY:deepseek:default',
    });
  });

  it('falls through to the next provider when the primary key is missing', () => {
    const resolved = resolveRelayModel('flash', entry, { FALLBACK_KEY: 'k2' } as NodeJS.ProcessEnv);
    expect(resolved).toMatchObject({ provider: 'openai-compatible', baseUrl: 'https://alt/v1', apiKey: 'k2' });
  });

  it('returns null when no provider in the chain has a key — never a half-configured upstream', () => {
    expect(resolveRelayModel('flash', entry, {} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('skips providers whose protocol the relay cannot passthrough', () => {
    const exotic: ModelEntry = { name: 'X', providers: [{ provider: 'bedrock', model: 'm', apiKeyEnv: 'K' }] };
    expect(resolveRelayModel('x', exotic, { K: 'k' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('defaults the deepseek base URL like the agent runtime does', () => {
    const only: ModelEntry = { name: 'D', providers: [{ provider: 'deepseek', model: 'm', apiKeyEnv: 'K' }] };
    expect(resolveRelayModel('d', only, { K: 'k' } as NodeJS.ProcessEnv)?.baseUrl).toBe('https://api.deepseek.com');
  });

  it('never leaks a key for an openai-compatible provider with no base URL', () => {
    const broken: ModelEntry = {
      name: 'B',
      providers: [{ provider: 'openai-compatible', model: 'm', apiKeyEnv: 'K' }],
    };
    expect(resolveRelayModel('b', broken, { K: 'k' } as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('parseAllowedModels', () => {
  it('returns null when meta is empty or has no list', () => {
    expect(parseAllowedModels(null)).toBeNull();
    expect(parseAllowedModels('{}')).toBeNull();
    expect(parseAllowedModels('{"auto":true}')).toBeNull();
  });

  it('extracts a string array, dropping non-strings', () => {
    expect(parseAllowedModels('{"allowed_models":["a","b",3]}')).toEqual(['a', 'b']);
  });
});

describe('isPassthroughKind', () => {
  it('passes OpenAI-family kinds only', () => {
    expect(isPassthroughKind('openai')).toBe(true);
    expect(isPassthroughKind('deepseek')).toBe(true);
    expect(isPassthroughKind('openai-compatible')).toBe(true);
    expect(isPassthroughKind('kimi')).toBe(false); // removed provider
    expect(isPassthroughKind('anthropic')).toBe(false);
  });
});

describe('upstreamChatUrl', () => {
  it('appends chat/completions, trimming slashes', () => {
    expect(upstreamChatUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/chat/completions');
    expect(upstreamChatUrl('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1/chat/completions');
  });
});

describe('upstreamHeaders', () => {
  it('uses Bearer auth for OpenAI-family', () => {
    expect(upstreamHeaders('openai', 'sk-x')).toMatchObject({ authorization: 'Bearer sk-x' });
  });
  it('rejects unsupported protocol kinds instead of advertising a partial implementation', () => {
    expect(() => upstreamHeaders('anthropic', 'sk-x')).toThrow(/Unsupported upstream protocol/);
  });
});

describe('buildUpstreamBody', () => {
  it('rewrites the model id', () => {
    const out = buildUpstreamBody({ model: 'claude-sonnet', messages: [] }, 'claude-sonnet-4-5');
    expect(out.model).toBe('claude-sonnet-4-5');
  });

  it('forces include_usage on streaming requests only', () => {
    const streamed = buildUpstreamBody({ model: 'x', stream: true }, 'real');
    expect(streamed.stream_options).toEqual({ include_usage: true });
    const nonStream = buildUpstreamBody({ model: 'x' }, 'real');
    expect(nonStream.stream_options).toBeUndefined();
  });

  it('preserves caller stream_options while adding include_usage', () => {
    const out = buildUpstreamBody({ model: 'x', stream: true, stream_options: { foo: 1 } }, 'real');
    expect(out.stream_options).toEqual({ foo: 1, include_usage: true });
  });

  it('forwards the caller sampling params untouched', () => {
    const sent = { model: 'flash', temperature: 0.4, top_p: 0.9, frequency_penalty: 0.5, presence_penalty: 0.5 };
    expect(buildUpstreamBody(sent, 'deepseek-flash')).toEqual({ ...sent, model: 'deepseek-flash' });
  });
});

describe('applyRelayOutputLimit', () => {
  it('materializes the catalog cap when omitted and preserves a lower client cap', () => {
    expect(applyRelayOutputLimit({ messages: [] }, 4096)).toEqual({
      body: { messages: [], max_tokens: 4096 },
      outputTokenLimit: 4096,
    });
    expect(applyRelayOutputLimit({ messages: [], max_tokens: 512 }, 4096)).toEqual({
      body: { messages: [], max_tokens: 512 },
      outputTokenLimit: 512,
    });
  });

  it('rejects invalid, ambiguous, or above-catalog output limits', () => {
    expect(() => applyRelayOutputLimit({ max_tokens: 0 }, 4096)).toThrow(/positive integer/);
    expect(() => applyRelayOutputLimit({ max_tokens: 5000 }, 4096)).toThrow(/model maximum/);
    expect(() => applyRelayOutputLimit({ max_tokens: 1, max_completion_tokens: 1 }, 4096)).toThrow(/either/);
  });
});

describe('usage extraction', () => {
  it('reads usage from a non-streaming JSON body', () => {
    expect(extractUsageFromJson({ usage: { prompt_tokens: 12, completion_tokens: 34 } })).toEqual({
      inputTokens: 12,
      outputTokens: 34,
    });
    expect(extractUsageFromJson({})).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('reads usage from an SSE usage chunk', () => {
    const line = 'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7}}';
    expect(extractUsageFromSseChunk(line)).toEqual({ inputTokens: 5, outputTokens: 7 });
  });

  it('returns null for delta / DONE / non-data lines', () => {
    expect(extractUsageFromSseChunk('data: {"choices":[{"delta":{"content":"hi"}}]}')).toBeNull();
    expect(extractUsageFromSseChunk('data: [DONE]')).toBeNull();
    expect(extractUsageFromSseChunk(': keep-alive')).toBeNull();
    expect(extractUsageFromSseChunk('')).toBeNull();
  });
});

describe('toModelsListResponse', () => {
  const relayModel: RelayModel = {
    id: 'flash',
    displayName: 'Flash',
    provider: 'deepseek',
    upstreamModel: 'v4-flash',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'secret-key',
    scopeId: 'PRIMARY_KEY:deepseek:default',
  };

  it('shapes an OpenAI-compatible models list', () => {
    const res = toModelsListResponse([relayModel]);
    expect(res.object).toBe('list');
    expect(res.data[0]).toMatchObject({ id: 'flash', display_name: 'Flash', object: 'model' });
  });

  it('never exposes the upstream key or endpoint to the client', () => {
    const serialized = JSON.stringify(toModelsListResponse([relayModel]));
    expect(serialized).not.toContain('secret-key');
    expect(serialized).not.toContain('api.deepseek.com');
  });
});
