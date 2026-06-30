/**
 * Tests for the LLM Gateway relay pure helpers.
 */

import { describe, it, expect } from 'vitest';
import type { LlmGatewayModelRow } from '@greenhouse/db';
import {
  resolveModelSubset,
  parseAllowedModels,
  isPassthroughKind,
  upstreamChatUrl,
  upstreamHeaders,
  buildUpstreamBody,
  extractUsageFromJson,
  extractUsageFromSseChunk,
  toModelsListResponse,
} from '../relay-proxy.js';

function model(over: Partial<LlmGatewayModelRow>): LlmGatewayModelRow {
  return {
    id: over.id ?? 'm1',
    public_id: over.public_id ?? 'claude-sonnet',
    display_name: over.display_name ?? 'Claude Sonnet',
    upstream_id: over.upstream_id ?? 'u1',
    upstream_model: over.upstream_model ?? 'claude-sonnet-4-5',
    enabled: over.enabled ?? true,
    is_default: over.is_default ?? false,
    is_public: over.is_public ?? true,
    sort_order: over.sort_order ?? 0,
    created_at: over.created_at ?? '2026-01-01T00:00:00.000Z',
    updated_at: over.updated_at ?? '2026-01-01T00:00:00.000Z',
  };
}

describe('resolveModelSubset', () => {
  const models = [
    model({ id: 'a', public_id: 'pub-a', is_public: true }),
    model({ id: 'b', public_id: 'pub-b', is_public: false }),
    model({ id: 'c', public_id: 'pub-c', is_public: true }),
  ];

  it('falls back to the public subset when no allowlist', () => {
    expect(resolveModelSubset(null, models).map((m) => m.public_id)).toEqual(['pub-a', 'pub-c']);
    expect(resolveModelSubset([], models).map((m) => m.public_id)).toEqual(['pub-a', 'pub-c']);
  });

  it('restricts to the explicit allowlist (including non-public models)', () => {
    expect(resolveModelSubset(['pub-b'], models).map((m) => m.public_id)).toEqual(['pub-b']);
  });

  it('ignores allowlist entries that are not enabled/known', () => {
    expect(resolveModelSubset(['pub-a', 'ghost'], models).map((m) => m.public_id)).toEqual(['pub-a']);
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
  it('passes OpenAI-family kinds, not Anthropic', () => {
    expect(isPassthroughKind('openai')).toBe(true);
    expect(isPassthroughKind('deepseek')).toBe(true);
    expect(isPassthroughKind('openai-compatible')).toBe(true);
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
  it('uses Bearer auth for all passthrough kinds (OpenAI wire format)', () => {
    expect(upstreamHeaders('openai', 'sk-x')).toMatchObject({ authorization: 'Bearer sk-x' });
    expect(upstreamHeaders('deepseek', 'sk-x')).toMatchObject({ authorization: 'Bearer sk-x' });
    expect(upstreamHeaders('openai-compatible', 'sk-x')).toMatchObject({ authorization: 'Bearer sk-x' });
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
  it('shapes an OpenAI-compatible models list', () => {
    const res = toModelsListResponse([model({ public_id: 'pub-a', display_name: 'A' })]);
    expect(res.object).toBe('list');
    expect(res.data[0]).toMatchObject({ id: 'pub-a', object: 'model', owned_by: 'greenhouse-gateway' });
  });
});
