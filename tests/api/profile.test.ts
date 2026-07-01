/**
 * Tests for Agent Profile loading and validation (TS profile modules).
 */

import { describe, it, expect } from 'vitest';
import { loadProfile, registerKnownTools } from '../../apps/api/src/profile.js';

const KNOWN_TOOLS = [
  'knowledge_query',
  'knowledge_mutation',
  'analyze_image',
  'external_search',
  'feature_request',
  'generate_image',
  'project_manager',
  'ask_user',
];
registerKnownTools(KNOWN_TOOLS);

describe('Profile: default', () => {
  const profile = loadProfile('default');

  it('has required fields', () => {
    expect(profile.id).toBe('default');
    expect(profile.name).toBeDefined();
    expect(profile.system_prompt).toBeDefined();
    expect(profile.model).toBeDefined();
    expect(profile.tools).toBeDefined();
  });

  it('has valid model config (registry-based model.id)', () => {
    expect(profile.model.id).toBe('flash');
  });

  it('references known tools', () => {
    for (const tool of profile.tools) {
      expect(KNOWN_TOOLS).toContain(tool);
    }
  });

  it('has core tools', () => {
    expect(profile.tools).toContain('knowledge_query');
    expect(profile.tools).toContain('analyze_image');
    expect(profile.tools).toContain('ask_user');
    expect(profile.tools.length).toBeGreaterThanOrEqual(3);
  });

  it('system_prompt is non-empty', () => {
    expect(profile.system_prompt.length).toBeGreaterThan(100);
  });

  it('has reasonable max_steps', () => {
    expect(profile.max_steps).toBe(12);
  });

  it('has auto tool_choice', () => {
    expect(profile.tool_choice).toBe('auto');
  });

  it('is public and not rich-output', () => {
    expect(profile.access.level).toBe('public');
    expect(profile.access.rich_output).toBe(false);
  });
});

describe('Profile: validation', () => {
  it('default profile only uses known tools', () => {
    const profile = loadProfile('default');
    for (const tool of profile.tools) {
      expect(KNOWN_TOOLS).toContain(tool);
    }
  });

  it('throws for an unknown profile id', () => {
    expect(() => loadProfile('nope')).toThrow(/Profile not found/);
  });

  it('rejects an unsafe profile id (path traversal)', () => {
    expect(() => loadProfile('../etc')).toThrow(/Invalid profile ID/);
  });
});
