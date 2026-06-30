/** Tests for consolidated Agent Profiles. */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

const PROFILES_DIR = resolve(import.meta.dirname, '../../apps/api/src/profiles');
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
  'team_knowledge',
  'personal_knowledge',
  'session_history',
];

function loadProfile(id: string) {
  const filePath = resolve(PROFILES_DIR, `${id}.yaml`);
  if (!existsSync(filePath)) return null;
  return parseYaml(readFileSync(filePath, 'utf-8'));
}

describe('All profiles: structural validation', () => {
  const profileFiles = readdirSync(PROFILES_DIR).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

  it('has exactly 2 system profiles', () => {
    expect(profileFiles.length).toBe(2);
    expect(profileFiles.map((f) => f.replace(/\.ya?ml$/, '')).sort()).toEqual(['default', 'team']);
  });

  for (const file of profileFiles) {
    const id = file.replace(/\.ya?ml$/, '');
    describe(`Profile: ${id}`, () => {
      const profile = loadProfile(id);
      if (!profile) return;

      it('has required fields', () => {
        expect(profile.id).toBe(id);
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
    const profile = loadProfile('default')!;
    expect(profile.name).toBe('Greenhouse Assistant');
    expect(profile.access.level).toBe('public');
    expect(profile.tools).toContain('knowledge_query');
  });

  it('team is internal with rich output', () => {
    const profile = loadProfile('team')!;
    expect(profile.name).toBe('Team Assistant');
    expect(profile.access.level).toBe('internal');
    expect(profile.access.rich_output).toBe(true);
    expect(profile.tools).toContain('team_knowledge');
  });
});

describe('Profile module loading and legacy compatibility', () => {
  it('loadAllProfiles returns 2 system profiles', async () => {
    const { loadAllProfiles, clearProfileCache, registerKnownTools } = await import('../../apps/api/src/profile.js');
    registerKnownTools(KNOWN_TOOLS);
    clearProfileCache();
    expect(
      loadAllProfiles()
        .map((p) => p.id)
        .sort(),
    ).toEqual(['default', 'team']);
  });

  it('maps legacy preset IDs to team', async () => {
    const { resolveProfile, clearProfileCache } = await import('../../apps/api/src/profile.js');
    clearProfileCache();
    expect(resolveProfile('researcher').id).toBe('team');
    expect(resolveProfile('cc-analyzer').id).toBe('team');
  });

  it('validates custom base profile IDs', async () => {
    const { isValidCustomBaseProfileId } = await import('../../apps/api/src/profile.js');
    expect(isValidCustomBaseProfileId('default')).toBe(true);
    expect(isValidCustomBaseProfileId('team')).toBe(true);
    expect(isValidCustomBaseProfileId('desktop')).toBe(false);
    expect(isValidCustomBaseProfileId('researcher')).toBe(false);
  });

  it('resolveProfileAsync handles custom malformed IDs', async () => {
    const { resolveProfileAsync } = await import('../../apps/api/src/profile.js');
    await expect(resolveProfileAsync('custom:abc')).rejects.toThrow(/Invalid custom profile ID/);
  });
});
