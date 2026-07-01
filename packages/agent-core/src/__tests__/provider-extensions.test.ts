/**
 * GUARD + BEHAVIOR TEST — the agent-core fork extension seams (S3 + S11).
 *
 * Upstream ships every registry EMPTY: no fork providers, buildProviderOptions is
 * a no-op, and summarizeOutput uses only its built-in core cases. The behavior
 * tests prove a fork can re-add a provider / options / summarizer via the runtime
 * hooks without editing model.ts or chat-engine.ts.
 */

import { describe, it, expect } from 'vitest';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { createModelFromConfig, buildProviderOptions } from '../model.js';
import { summarizeOutput } from '../chat-engine.js';
import {
  registerProviderFactory,
  registerProviderOptionsBuilder,
  listRegisteredProviders,
} from '../provider-extensions.js';
import { registerToolOutputSummarizer } from '../tool-stream-hooks.js';

describe('agent-core provider/tool extension seams', () => {
  it('ships no fork providers upstream (OSS invariant)', () => {
    expect(listRegisteredProviders()).toEqual([]);
    expect(buildProviderOptions({ provider: 'openai-compatible', model: 'x' })).toBeUndefined();
  });

  it('an unknown provider throws until a fork registers a factory', async () => {
    await expect(createModelFromConfig({ provider: 'sentinel-llm', model: 'm' })).rejects.toThrow(
      /Unknown model provider/,
    );

    const sentinel = {
      specificationVersion: 'v3',
      provider: 'sentinel-llm',
      modelId: 'm',
    } as unknown as LanguageModelV3;
    registerProviderFactory('sentinel-llm', async () => sentinel);

    expect(listRegisteredProviders()).toContain('sentinel-llm');
    await expect(createModelFromConfig({ provider: 'sentinel-llm', model: 'm' })).resolves.toBe(sentinel);
  });

  it('a fork provider-options builder feeds buildProviderOptions', () => {
    registerProviderOptionsBuilder('sentinel-llm', () => ({ reasoning: true }));
    expect(buildProviderOptions({ provider: 'sentinel-llm', model: 'm' })).toEqual({ reasoning: true });
    // Unregistered provider still a no-op.
    expect(buildProviderOptions({ provider: 'openai', model: 'm' })).toBeUndefined();
  });

  it('summarizeOutput uses core cases upstream, fork summarizers take precedence', () => {
    // Core built-in unchanged.
    expect(summarizeOutput('knowledge_query', { action: 'search', found: 3, query: 'q' })).toEqual({
      action: 'search',
      found: 3,
      query: 'q',
    });
    // Unknown tool → passthrough.
    expect(summarizeOutput('letpot_source', { a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    // A fork summarizer overrides.
    registerToolOutputSummarizer('letpot_source', (o) => ({ found: o.found }));
    expect(summarizeOutput('letpot_source', { found: 7, noise: 1 })).toEqual({ found: 7 });
  });
});
