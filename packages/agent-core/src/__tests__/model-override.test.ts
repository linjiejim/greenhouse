/**
 * Regression tests for the model_override resolution path.
 *
 * Original bug (audit 2026-06-10 defect #4): the fast/slow-thinking toggle only
 * set `config.model`, but all profiles resolve through the registry (`config.id`),
 * so the override was silently ignored and usage was recorded against the
 * never-running model.
 *
 * The registry is now env-derived (OpenAI-compatible only): `flash`/`default`
 * map to LLM_MODEL and `pro` to LLM_MODEL_PRO (or LLM_MODEL). These tests pin
 * those env vars so the logical ids resolve deterministically.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyModelOverride, resolveModelChoice } from '../model.js';
import { findModelIdByProviderModel, getModelEntry } from '../registry.js';
import type { ModelConfig } from '../model.js';

const ENV_KEYS = ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_MODEL_PRO'] as const;

const FLASH_MODEL = 'flash-model';
const PRO_MODEL = 'pro-model';

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.LLM_API_KEY = 'sk-test';
  process.env.LLM_BASE_URL = 'https://api.example.com/v1';
  process.env.LLM_MODEL = FLASH_MODEL;
  process.env.LLM_MODEL_PRO = PRO_MODEL;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const profileConfig: ModelConfig = {
  id: 'flash',
  provider: 'openai-compatible',
  model: 'flash', // placeholder filled by profile loader
  options: { thinking: true, temperature: 0.4, max_tokens: 20000 },
};

describe('findModelIdByProviderModel', () => {
  it('maps a raw provider model string back to its registry id', () => {
    // pro model resolves to the `pro` id; flash model to `default` (first match).
    expect(findModelIdByProviderModel(PRO_MODEL)).toBe('pro');
    expect(findModelIdByProviderModel(FLASH_MODEL)).toBe('default');
  });

  it('returns undefined for unknown model strings', () => {
    expect(findModelIdByProviderModel('not-a-configured-model')).toBeUndefined();
  });
});

describe('applyModelOverride', () => {
  it('rewrites the registry id when the override is a raw provider model (the original bug)', () => {
    const result = applyModelOverride(profileConfig, PRO_MODEL);
    expect(result.id).toBe('pro'); // registry path now resolves the override
    expect(result.provider).toBe('openai-compatible');
    expect(result.model).toBe(PRO_MODEL); // usage records the running model
  });

  it('accepts a logical registry id directly', () => {
    const result = applyModelOverride(profileConfig, 'pro');
    expect(result.id).toBe('pro');
    expect(result.model).toBe(getModelEntry('pro')!.providers[0].model);
  });

  it('falls through to the direct provider+model path for unknown models', () => {
    const result = applyModelOverride(profileConfig, 'gpt-4o');
    expect(result.id).toBeUndefined(); // direct path — registry no longer shadows it
    expect(result.model).toBe('gpt-4o');
  });

  it('does not mutate the profile config and keeps profile options', () => {
    const result = applyModelOverride(profileConfig, PRO_MODEL);
    expect(profileConfig.id).toBe('flash');
    expect(profileConfig.model).toBe('flash');
    expect(result.options).toEqual(profileConfig.options);
  });
});

describe('resolveModelChoice', () => {
  const pinned: ModelConfig = { ...profileConfig }; // no choices declared
  const switchable: ModelConfig = {
    ...profileConfig,
    choices: [
      { id: 'flash', label: '快思考' },
      { id: 'pro', label: '慢思考' },
    ],
  };

  it('ignores every override for pinned profiles (no choices declared)', () => {
    expect(resolveModelChoice(pinned, 'pro')).toBeUndefined();
    expect(resolveModelChoice(pinned, PRO_MODEL)).toBeUndefined();
  });

  it('accepts a registry id listed in the profile choices', () => {
    expect(resolveModelChoice(switchable, 'pro')).toBe('pro');
    expect(resolveModelChoice(switchable, 'flash')).toBe('flash');
  });

  it('maps legacy raw provider model strings to their registry id before matching', () => {
    expect(resolveModelChoice(switchable, PRO_MODEL)).toBe('pro');
  });

  it('silently drops overrides outside the declared choices', () => {
    expect(resolveModelChoice(switchable, 'gpt-4o')).toBeUndefined();
  });

  it('returns undefined when no override is sent', () => {
    expect(resolveModelChoice(switchable, undefined)).toBeUndefined();
    expect(resolveModelChoice(switchable, null)).toBeUndefined();
  });
});
