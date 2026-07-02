/**
 * Tests for the env-derived, OpenAI-compatible model registry.
 *
 * The registry is built lazily from process.env on every call, so these tests
 * set LLM_* vars and read back the resolved entries. There is a single wire
 * protocol (openai-compatible); logical ids default/flash/pro all map to it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getModelEntry, getModelIds, getAvailableProviders, findModelIdByProviderModel } from '../registry.js';

const ENV_KEYS = ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_MODEL_PRO', 'LLM_MODEL_TITLE'] as const;

describe('Model Registry (env-derived, openai-compatible)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('exposes default/flash/pro/title logical ids', () => {
    const ids = getModelIds();
    expect(ids).toContain('default');
    expect(ids).toContain('flash');
    expect(ids).toContain('pro');
    expect(ids).toContain('title');
  });

  it('lets LLM_MODEL_TITLE override the title model while others stay on LLM_MODEL', () => {
    process.env.LLM_MODEL = 'main-model';
    process.env.LLM_MODEL_TITLE = 'light-model';
    expect(getModelEntry('default')!.providers[0].model).toBe('main-model');
    expect(getModelEntry('flash')!.providers[0].model).toBe('main-model');
    expect(getModelEntry('title')!.providers[0].model).toBe('light-model');
  });

  it('title defaults to LLM_MODEL when LLM_MODEL_TITLE is unset', () => {
    process.env.LLM_MODEL = 'only-model';
    expect(getModelEntry('title')!.providers[0].model).toBe('only-model');
  });

  it('resolves all ids to the configured openai-compatible upstream', () => {
    process.env.LLM_MODEL = 'gpt-4o-mini';
    process.env.LLM_BASE_URL = 'https://api.example.com/v1';

    for (const id of ['default', 'flash', 'pro']) {
      const entry = getModelEntry(id)!;
      expect(entry.providers).toHaveLength(1);
      expect(entry.providers[0].provider).toBe('openai-compatible');
      expect(entry.providers[0].model).toBe('gpt-4o-mini');
      expect(entry.providers[0].baseUrl).toBe('https://api.example.com/v1');
      expect(entry.providers[0].apiKeyEnv).toBe('LLM_API_KEY');
    }
  });

  it('falls back to gpt-4o-mini when LLM_MODEL is unset', () => {
    expect(getModelEntry('default')!.providers[0].model).toBe('gpt-4o-mini');
  });

  it('reads env lazily (a change after import is honored)', () => {
    process.env.LLM_MODEL = 'first-model';
    expect(getModelEntry('default')!.providers[0].model).toBe('first-model');
    process.env.LLM_MODEL = 'second-model';
    expect(getModelEntry('default')!.providers[0].model).toBe('second-model');
  });

  it('lets LLM_MODEL_PRO override the pro model while default/flash stay on LLM_MODEL', () => {
    process.env.LLM_MODEL = 'small-model';
    process.env.LLM_MODEL_PRO = 'big-model';
    expect(getModelEntry('default')!.providers[0].model).toBe('small-model');
    expect(getModelEntry('flash')!.providers[0].model).toBe('small-model');
    expect(getModelEntry('pro')!.providers[0].model).toBe('big-model');
  });

  it('pro defaults to LLM_MODEL when LLM_MODEL_PRO is unset', () => {
    process.env.LLM_MODEL = 'only-model';
    expect(getModelEntry('pro')!.providers[0].model).toBe('only-model');
  });

  it('getAvailableProviders returns the entry only when LLM_API_KEY is configured', () => {
    process.env.LLM_MODEL = 'm';
    expect(getAvailableProviders('default')).toHaveLength(0);
    process.env.LLM_API_KEY = 'sk-test';
    const available = getAvailableProviders('default');
    expect(available).toHaveLength(1);
    expect(available[0].provider).toBe('openai-compatible');
  });

  it('getAvailableProviders returns empty for unknown ids', () => {
    process.env.LLM_API_KEY = 'sk-test';
    expect(getAvailableProviders('nope')).toEqual([]);
  });

  it('findModelIdByProviderModel maps the configured model back to a registry id', () => {
    process.env.LLM_MODEL = 'gpt-4o-mini';
    expect(findModelIdByProviderModel('gpt-4o-mini')).toBeDefined();
    expect(findModelIdByProviderModel('totally-unknown')).toBeUndefined();
  });

  it('returns undefined for an unknown logical id', () => {
    expect(getModelEntry('ollama-was-here')).toBeUndefined();
  });
});
