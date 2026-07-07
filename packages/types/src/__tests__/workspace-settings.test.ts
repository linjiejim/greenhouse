/** Tests for the workspace settings registry + ThemeTokens sanitizer. */

import { describe, it, expect } from 'vitest';
import { WORKSPACE_SETTINGS, getWorkspaceSettingDef, sanitizeThemeTokens } from '../workspace-settings';

describe('WORKSPACE_SETTINGS registry', () => {
  it('has unique keys', () => {
    const keys = WORKSPACE_SETTINGS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has unique env mappings (two settings must never fight over one var)', () => {
    const envs = WORKSPACE_SETTINGS.map((s) => s.env).filter(Boolean);
    expect(new Set(envs).size).toBe(envs.length);
  });

  it('keys follow the group.name convention and match their group field', () => {
    for (const s of WORKSPACE_SETTINGS) {
      expect(s.key).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(s.key.startsWith(`${s.group}.`)).toBe(true);
    }
  });

  it('secrets are all plain strings (encrypted whole, never partially)', () => {
    for (const s of WORKSPACE_SETTINGS.filter((x) => x.secret)) {
      expect(s.type).toBe('string');
    }
  });

  it('looks up defs by key', () => {
    expect(getWorkspaceSettingDef('llm.api_key')?.secret).toBe(true);
    expect(getWorkspaceSettingDef('llm.api_key')?.env).toBe('LLM_API_KEY');
    expect(getWorkspaceSettingDef('nope.nope')).toBeUndefined();
  });
});

describe('sanitizeThemeTokens', () => {
  it('passes a clean payload through', () => {
    const tokens = sanitizeThemeTokens({
      brand: '#14b8a6',
      fontSans: "'Inter', ui-sans-serif, system-ui, sans-serif",
      fontScale: 1.05,
      radiusScale: 0.5,
      light: { '--t-surface': '#ffffff' },
      dark: { '--t-surface': '#111827' },
    });
    expect(tokens).toEqual({
      brand: '#14b8a6',
      fontSans: "'Inter', ui-sans-serif, system-ui, sans-serif",
      fontScale: 1.05,
      radiusScale: 0.5,
      light: { '--t-surface': '#ffffff' },
      dark: { '--t-surface': '#111827' },
    });
  });

  it('drops CSS-injection attempts in var names and values', () => {
    const tokens = sanitizeThemeTokens({
      light: {
        '--t-surface': '#fff; } body { display:none', // value tries to escape
        'not-a-var': '#fff',
        '--t-ok': '#123456',
      },
    });
    expect(tokens).toEqual({ light: { '--t-ok': '#123456' } });
  });

  it('rejects font stacks with declaration-breaking characters', () => {
    expect(sanitizeThemeTokens({ fontSans: 'Inter; } * { color: red' })).toBeNull();
    expect(sanitizeThemeTokens({ fontSans: 'url(evil)' })).toBeNull();
  });

  it('rejects invalid brand hexes and clamps scales', () => {
    expect(sanitizeThemeTokens({ brand: 'red' })).toBeNull();
    expect(sanitizeThemeTokens({ brand: '#14b8a6', fontScale: 99 })).toEqual({ brand: '#14b8a6', fontScale: 1.2 });
    expect(sanitizeThemeTokens({ brand: '#14b8a6', radiusScale: -3 })).toEqual({ brand: '#14b8a6', radiusScale: 0 });
  });

  it('returns null when nothing valid remains', () => {
    expect(sanitizeThemeTokens(null)).toBeNull();
    expect(sanitizeThemeTokens('x')).toBeNull();
    expect(sanitizeThemeTokens({})).toBeNull();
    expect(sanitizeThemeTokens({ light: { 'bad key': 'bad;value' } })).toBeNull();
  });
});
