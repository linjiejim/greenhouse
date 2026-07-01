/** Tests for the profile manifest schema (single source of truth). */

import { describe, it, expect } from 'vitest';
import {
  profileManifestSchema,
  profileDataSchema,
  systemProfileSchema,
  MAX_SYSTEM_PROMPT,
} from '../profile-manifest.js';

describe('profileManifestSchema', () => {
  const valid = {
    name: 'My Researcher',
    system_prompt: 'You are a helpful research assistant.',
    tools: ['knowledge_query'],
  };

  it('accepts a minimal valid manifest and applies defaults', () => {
    const parsed = profileManifestSchema.parse(valid);
    expect(parsed.name).toBe('My Researcher');
    expect(parsed.base_profile_id).toBe('default'); // default applied
    expect(parsed.max_steps).toBe(12); // default applied
    expect(parsed.tool_choice).toBe('auto'); // default applied
    expect(parsed.capabilities).toEqual([]); // default applied
  });

  it('strips unknown / privileged injected fields', () => {
    const parsed = profileManifestSchema.parse({
      ...valid,
      access: { level: 'public', requires_session: false, rich_output: false },
      model: { provider: 'openai', model: 'x', apiKey: 'SECRET_ENV' },
      is_shared: true,
    } as Record<string, unknown>);
    expect('access' in parsed).toBe(false);
    expect('model' in parsed).toBe(false);
    expect('is_shared' in parsed).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(() => profileManifestSchema.parse({ ...valid, name: '' })).toThrow();
  });

  it('rejects an over-long system prompt', () => {
    expect(() => profileManifestSchema.parse({ ...valid, system_prompt: 'x'.repeat(MAX_SYSTEM_PROMPT + 1) })).toThrow();
  });

  it('rejects an out-of-range temperature', () => {
    expect(() => profileManifestSchema.parse({ ...valid, model_options: { temperature: 5 } })).toThrow();
  });

  it('rejects an invalid base profile', () => {
    expect(() => profileManifestSchema.parse({ ...valid, base_profile_id: 'admin' })).toThrow();
  });

  it('accepts the new safe config fields', () => {
    const parsed = profileManifestSchema.parse({
      ...valid,
      model_options: { thinking: true, temperature: 0.4, max_tokens: 2000 },
      model_choice_ids: ['flash', 'pro'],
      default_language: 'English',
      greeting: 'Hi! How can I help?',
      suggested_followups: ['Summarize this', 'Find sources'],
    });
    expect(parsed.model_options?.temperature).toBe(0.4);
    expect(parsed.model_choice_ids).toEqual(['flash', 'pro']);
    expect(parsed.suggested_followups).toHaveLength(2);
  });
});

describe('profileDataSchema (jsonb payload)', () => {
  it('omits the relational column fields', () => {
    const shape = profileDataSchema.shape as Record<string, unknown>;
    expect('name' in shape).toBe(false);
    expect('slug' in shape).toBe(false);
    expect('base_profile_id' in shape).toBe(false);
    expect('system_prompt' in shape).toBe(true);
    expect('tools' in shape).toBe(true);
    expect('model_options' in shape).toBe(true);
  });
});

describe('systemProfileSchema (first-party superset)', () => {
  const base = {
    id: 'default',
    name: 'Greenhouse Assistant',
    system_prompt: 'You are a helpful assistant.',
    tools: ['knowledge_query'],
    access: { level: 'public', requires_session: false, rich_output: false },
    model: { provider: 'openai-compatible', model: 'flash', id: 'flash' },
  };

  it('accepts a valid system profile', () => {
    const parsed = systemProfileSchema.parse(base);
    expect(parsed.id).toBe('default');
    expect(parsed.access.level).toBe('public');
    expect(parsed.hidden).toBe(false); // default
  });

  it('rejects an invalid access level', () => {
    expect(() => systemProfileSchema.parse({ ...base, access: { ...base.access, level: 'root' } })).toThrow();
  });

  it('rejects an id with path traversal characters', () => {
    expect(() => systemProfileSchema.parse({ ...base, id: '../etc' })).toThrow();
  });
});
