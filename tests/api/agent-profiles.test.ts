/** Tests for consolidated Agent Profiles (TS profile modules + manifest schema). */

import { describe, it, expect } from 'vitest';
import {
  loadAllProfiles,
  loadProfile,
  resolveProfile,
  resolveProfileAsync,
  clearProfileCache,
  registerKnownTools,
  isValidCustomBaseProfileId,
} from '../../apps/api/src/profile.js';

const KNOWN_TOOLS = [
  'knowledge_query',
  'knowledge_mutation',
  'analyze_image',
  'external_search',
  'feature_request',
  'generate_image',
  'project_manager',
  'ask_user',
  'compute',
  'email_manager',
  'session_history',
];
registerKnownTools(KNOWN_TOOLS);

describe('All profiles: structural validation', () => {
  const all = loadAllProfiles();

  it('has exactly 2 system profiles', () => {
    expect(all.map((p) => p.id).sort()).toEqual(['default', 'team']);
  });

  for (const profile of all) {
    describe(`Profile: ${profile.id}`, () => {
      it('has required fields', () => {
        expect(profile.name).toBeDefined();
        expect(profile.system_prompt).toBeDefined();
        expect(profile.model?.id).toBeDefined();
        expect(['flash', 'pro']).toContain(profile.model.id);
      });

      it('has valid tools', () => {
        expect(Array.isArray(profile.tools)).toBe(true);
        for (const tool of profile.tools) expect(KNOWN_TOOLS).toContain(tool);
      });

      it('has valid access config and version', () => {
        expect(['public', 'internal', 'admin', 'hidden']).toContain(profile.access.level);
        expect(typeof profile.access.requires_session).toBe('boolean');
        expect(typeof profile.access.rich_output).toBe('boolean');
        expect(profile.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });
    });
  }
});

describe('Profile identities', () => {
  it('default is public', () => {
    const profile = loadProfile('default');
    expect(profile.name).toBe('Greenhouse Assistant');
    expect(profile.access.level).toBe('public');
    expect(profile.tools).toContain('knowledge_query');
  });

  it('team is internal with rich output', () => {
    const profile = loadProfile('team');
    expect(profile.name).toBe('Team Assistant');
    expect(profile.access.level).toBe('internal');
    expect(profile.access.rich_output).toBe(true);
    expect(profile.tools).toContain('knowledge_query');
  });

  it('team declares switchable model choices; default does not', () => {
    expect(loadProfile('team').model.choices?.map((c) => c.id)).toEqual(['flash', 'pro']);
    expect(loadProfile('default').model.choices).toBeUndefined();
  });
});

describe('Profile module loading and legacy compatibility', () => {
  it('loadAllProfiles returns 2 system profiles', () => {
    clearProfileCache();
    expect(
      loadAllProfiles()
        .map((p) => p.id)
        .sort(),
    ).toEqual(['default', 'team']);
  });

  it('maps legacy preset IDs to team', () => {
    expect(resolveProfile('researcher').id).toBe('team');
    expect(resolveProfile('cc-analyzer').id).toBe('team');
  });

  it('validates custom base profile IDs', () => {
    expect(isValidCustomBaseProfileId('default')).toBe(true);
    expect(isValidCustomBaseProfileId('team')).toBe(true);
    expect(isValidCustomBaseProfileId('desktop')).toBe(false);
    expect(isValidCustomBaseProfileId('researcher')).toBe(false);
  });

  it('resolveProfileAsync rejects malformed custom IDs', async () => {
    await expect(resolveProfileAsync('custom:abc')).rejects.toThrow(/Invalid custom profile ID/);
  });
});
