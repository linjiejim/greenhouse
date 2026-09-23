import { describe, expect, it } from 'vitest';
import { buildRelayModelsConfig, parseModelMaxTokens } from '../models-config.js';

describe('runner models.json', () => {
  it('declares the relay cap so the SDK never asks for more than the relay accepts', () => {
    const cfg = buildRelayModelsConfig({
      providerId: 'greenhouse-relay',
      apiBase: 'http://api:3000',
      model: 'flash',
      fallbackModel: 'deepseek-flash',
      maxTokens: { flash: 16000 },
    });
    const provider = cfg.providers['greenhouse-relay'];
    expect(provider.baseUrl).toBe('http://api:3000/api/llm/v1');
    expect(provider.models).toEqual([
      { id: 'flash', name: 'flash', maxTokens: 16000 },
      { id: 'deepseek-flash', name: 'deepseek-flash' },
    ]);
  });

  it('lists a fallback equal to the model once', () => {
    const cfg = buildRelayModelsConfig({
      providerId: 'p',
      apiBase: 'x',
      model: 'flash',
      fallbackModel: 'flash',
      maxTokens: {},
    });
    expect(cfg.providers.p.models).toHaveLength(1);
  });

  it('ignores a missing or malformed cap map and keeps only positive integers', () => {
    expect(parseModelMaxTokens(undefined)).toEqual({});
    expect(parseModelMaxTokens('not json')).toEqual({});
    expect(parseModelMaxTokens('[1]')).toEqual({});
    expect(parseModelMaxTokens('{"flash":16000,"bad":-1,"str":"9","frac":1.5}')).toEqual({ flash: 16000 });
  });
});
