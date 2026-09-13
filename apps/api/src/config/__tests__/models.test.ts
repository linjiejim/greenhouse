/**
 * Model catalog parsing. The catalog is the only place a deployment declares
 * what it can talk to, so a malformed file must fail loudly at boot rather than
 * degrade into "no provider available" on someone's first message.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseModelCatalog } from '../models.js';

const MINIMAL = `
models:
  flash:
    name: Flash
    providers:
      - { provider: deepseek, model: m-flash, api_key_env: LLM_API_KEY }
relay:
  default: flash
  public: [flash]
`;

describe('parseModelCatalog', () => {
  it('parses models, provider chains and the relay catalog', () => {
    const catalog = parseModelCatalog(`
models:
  flash:
    name: Flash
    providers:
      - { provider: deepseek, model: m-flash, api_key_env: LLM_API_KEY }
      - { provider: openai-compatible, model: alt, api_key_env: OTHER_KEY, base_url: https://x/v1 }
  pro:
    providers:
      - { provider: deepseek, model: m-pro, api_key_env: LLM_API_KEY }
relay:
  default: pro
  public: [flash, pro]
`);

    expect(Object.keys(catalog.models)).toEqual(['flash', 'pro']);
    expect(catalog.models.flash!.providers).toHaveLength(2);
    expect(catalog.models.flash!.providers[1]).toEqual({
      provider: 'openai-compatible',
      model: 'alt',
      apiKeyEnv: 'OTHER_KEY',
      baseUrl: 'https://x/v1',
    });
    expect(catalog.models.pro!.name).toBe('pro'); // falls back to the id
    expect(catalog.relay).toEqual({ default: 'pro', public: ['flash', 'pro'] });
  });

  it('never carries a secret — only the env var name', () => {
    const catalog = parseModelCatalog(MINIMAL);
    expect(JSON.stringify(catalog)).not.toMatch(/api_key["']?\s*:/);
    expect(catalog.models.flash!.providers[0]!.apiKeyEnv).toBe('LLM_API_KEY');
  });

  it('rejects an empty catalog', () => {
    expect(() => parseModelCatalog('models: {}')).toThrow(/at least one model/);
    expect(() => parseModelCatalog('relay: {}')).toThrow(/at least one model/);
  });

  it('rejects a model without providers', () => {
    expect(() => parseModelCatalog('models:\n  flash:\n    name: Flash\n')).toThrow(/non-empty list/);
  });

  it('rejects a provider missing its env var name', () => {
    expect(() =>
      parseModelCatalog('models:\n  flash:\n    providers:\n      - { provider: deepseek, model: m }\n'),
    ).toThrow(/api_key_env/);
  });

  it('parses context_window and compaction_threshold', () => {
    const catalog = parseModelCatalog(`
models:
  flash:
    context_window: 1000000
    compaction_threshold: 0.4
    providers:
      - { provider: deepseek, model: m-flash, api_key_env: LLM_API_KEY }
`);
    expect(catalog.models.flash!.contextWindow).toBe(1_000_000);
    expect(catalog.models.flash!.compactionThreshold).toBe(0.4);
  });

  it('rejects a malformed context_window or out-of-range compaction_threshold', () => {
    const withWindow = (v: string) =>
      `models:\n  flash:\n    context_window: ${v}\n    providers:\n      - { provider: deepseek, model: m, api_key_env: K }\n`;
    expect(() => parseModelCatalog(withWindow('-1'))).toThrow(/context_window/);
    expect(() => parseModelCatalog(withWindow('lots'))).toThrow(/context_window/);

    const withThreshold = (v: string) =>
      `models:\n  flash:\n    context_window: 100000\n    compaction_threshold: ${v}\n    providers:\n      - { provider: deepseek, model: m, api_key_env: K }\n`;
    expect(() => parseModelCatalog(withThreshold('0'))).toThrow(/compaction_threshold/);
    expect(() => parseModelCatalog(withThreshold('0.95'))).toThrow(/compaction_threshold/);
  });

  it('rejects a compaction_threshold without a context_window', () => {
    expect(() =>
      parseModelCatalog(
        `models:\n  flash:\n    compaction_threshold: 0.5\n    providers:\n      - { provider: deepseek, model: m, api_key_env: K }\n`,
      ),
    ).toThrow(/requires context_window/);
  });

  it('rejects a relay entry pointing at an unknown model', () => {
    expect(() => parseModelCatalog(MINIMAL.replace('default: flash', 'default: ghost'))).toThrow(/unknown model/);
    expect(() => parseModelCatalog(MINIMAL.replace('public: [flash]', 'public: [flash, ghost]'))).toThrow(
      /unknown model/,
    );
  });

  it('defaults the relay catalog to every model when the section is absent', () => {
    const catalog = parseModelCatalog(
      'models:\n  a:\n    providers:\n      - { provider: p, model: m, api_key_env: K }\n',
    );
    expect(catalog.relay).toEqual({ default: 'a', public: ['a'] });
  });

  it('parses the vision flag and rejects non-boolean values', () => {
    const withVision = (v: string) =>
      `models:\n  m3:\n    vision: ${v}\n    providers:\n      - { provider: minimax, model: MiniMax-M3, api_key_env: K }\n`;
    expect(parseModelCatalog(withVision('true')).models.m3!.vision).toBe(true);
    expect(parseModelCatalog(withVision('false')).models.m3!.vision).toBe(false);
    expect(parseModelCatalog(MINIMAL).models.flash!.vision).toBeUndefined(); // absent = text-only
    expect(() => parseModelCatalog(withVision('yes please'))).toThrow(/vision/);
  });

  it('ships MiniMax M3 as a vision model on the CN coding-plan endpoint, off the public relay subset', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../models.yaml'), 'utf-8');
    const catalog = parseModelCatalog(source);

    expect(catalog.models['minimax-m3']!.providers).toEqual([
      {
        provider: 'minimax',
        model: 'MiniMax-M3',
        apiKeyEnv: 'MINIMAX_API_KEY',
        baseUrl: 'https://api.minimaxi.com/v1',
      },
    ]);
    // This is what routes attached images straight into the payload.
    expect(catalog.models['minimax-m3']!.vision).toBe(true);
    expect(catalog.chat.selectable).toContain('minimax-m3');
    // The MiniMax coding plan is a fixed shared quota — same rule as kimi-k3.
    expect(catalog.relay.public).not.toContain('minimax-m3');
  });

  it('ships Kimi K3 on the coding-plan endpoint, kept off the public relay subset', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../models.yaml'), 'utf-8');
    const catalog = parseModelCatalog(source);

    expect(catalog.models['kimi-k3']!.providers).toEqual([
      { provider: 'kimi', model: 'k3-256k', apiKeyEnv: 'KIMI_API_KEY', baseUrl: 'https://api.kimi.com/coding/v1' },
    ]);
    // The Kimi Code plan is a fixed shared quota, so relay keys reach it only
    // through an explicit `allowed_models` grant — never by default.
    expect(catalog.relay.public).not.toContain('kimi-k3');
  });

  it('resolves model_env / base_url_env at parse time and drops providers whose model env is unset', () => {
    const previous = { model: process.env.LLM_MODEL, base: process.env.LLM_BASE_URL, pro: process.env.LLM_MODEL_PRO };
    process.env.LLM_MODEL = 'gpt-4o-mini';
    process.env.LLM_BASE_URL = 'https://llm.example.com/v1/';
    delete process.env.LLM_MODEL_PRO;
    try {
      const catalog = parseModelCatalog(`
models:
  flash:
    providers:
      - { provider: openai-compatible, model_env: LLM_MODEL, api_key_env: LLM_API_KEY, base_url_env: LLM_BASE_URL }
  pro:
    providers:
      - { provider: openai-compatible, model_env: LLM_MODEL_PRO, api_key_env: LLM_API_KEY, base_url_env: LLM_BASE_URL }
`);
      expect(catalog.models.flash!.providers).toEqual([
        {
          provider: 'openai-compatible',
          model: 'gpt-4o-mini',
          apiKeyEnv: 'LLM_API_KEY',
          baseUrl: 'https://llm.example.com/v1/',
        },
      ]);
      // An unset model env is "not configured", not a boot failure.
      expect(catalog.models.pro!.providers).toEqual([]);
    } finally {
      if (previous.model === undefined) delete process.env.LLM_MODEL;
      else process.env.LLM_MODEL = previous.model;
      if (previous.base === undefined) delete process.env.LLM_BASE_URL;
      else process.env.LLM_BASE_URL = previous.base;
      if (previous.pro !== undefined) process.env.LLM_MODEL_PRO = previous.pro;
    }
  });

  it('rejects a provider with neither model nor model_env', () => {
    expect(() =>
      parseModelCatalog('models:\n  flash:\n    providers:\n      - { provider: deepseek, api_key_env: K }\n'),
    ).toThrow(/model/);
  });

  it('the shipped config file is valid and serves any OpenAI-compatible endpoint from LLM_MODEL', () => {
    const previous = process.env.LLM_MODEL;
    process.env.LLM_MODEL = 'my-model';
    try {
      const source = readFileSync(resolve(import.meta.dirname, '../models.yaml'), 'utf-8');
      const catalog = parseModelCatalog(source);
      expect(Object.keys(catalog.models).length).toBeGreaterThan(0);
      expect(catalog.models.flash!.providers[0]).toMatchObject({ provider: 'openai-compatible', model: 'my-model' });
      expect(catalog.relay.default).toBe('flash');
      expect(catalog.chat.selectable[0]).toBe('flash');
      for (const [id, entry] of Object.entries(catalog.models)) {
        // Optional ids may have an empty chain when their env is unset (pro);
        // every configured id must resolve at least one provider.
        if (id !== 'pro') expect(entry.providers.length, id).toBeGreaterThan(0);
      }
    } finally {
      if (previous === undefined) delete process.env.LLM_MODEL;
      else process.env.LLM_MODEL = previous;
    }
  });
});
