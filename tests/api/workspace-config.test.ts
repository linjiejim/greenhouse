/**
 * Workspace config — write-path validation tests (pure, no DB).
 *
 * validateWorkspaceValue guards everything an admin can PUT to
 * /api/admin/settings: logo data URLs, http(s) base URLs, theme tokens,
 * the team avatar DSL and plain string limits.
 */

import { describe, it, expect } from 'vitest';
import { validateWorkspaceValue } from '../../apps/api/src/settings/workspace-config.js';
import { getWorkspaceSettingDef } from '@greenhouse/types/workspace-settings';

function def(key: string) {
  const d = getWorkspaceSettingDef(key);
  if (!d) throw new Error(`no def for ${key}`);
  return d;
}

describe('validateWorkspaceValue', () => {
  it('accepts and trims plain strings', () => {
    const r = validateWorkspaceValue(def('llm.model'), '  gpt-4o-mini  ');
    expect(r).toEqual({ ok: true, value: 'gpt-4o-mini' });
  });

  it('rejects non-strings for string settings and over-long values', () => {
    expect(validateWorkspaceValue(def('llm.model'), 42).ok).toBe(false);
    expect(validateWorkspaceValue(def('branding.product_name'), 'x'.repeat(61)).ok).toBe(false);
  });

  it('validates base URLs as http(s)', () => {
    expect(validateWorkspaceValue(def('llm.base_url'), 'https://api.openai.com/v1').ok).toBe(true);
    expect(validateWorkspaceValue(def('llm.base_url'), 'ftp://x').ok).toBe(false);
    expect(validateWorkspaceValue(def('llm.base_url'), 'not a url').ok).toBe(false);
  });

  it('validates the logo as an image data URL with an allowed mime', () => {
    const png = `data:image/png;base64,${'A'.repeat(80)}`;
    expect(validateWorkspaceValue(def('branding.logo'), png).ok).toBe(true);
    expect(validateWorkspaceValue(def('branding.logo'), 'https://evil/logo.png').ok).toBe(false);
    expect(validateWorkspaceValue(def('branding.logo'), 'data:text/html;base64,PGI+').ok).toBe(false);
  });

  it('sanitizes theme tokens and rejects payloads with nothing valid', () => {
    const good = validateWorkspaceValue(def('branding.theme_tokens'), {
      brand: '#4f46e5',
      light: { '--t-surface': '#ffffff', 'bad key': 'x;y' },
    });
    expect(good).toEqual({ ok: true, value: { brand: '#4f46e5', light: { '--t-surface': '#ffffff' } } });
    expect(validateWorkspaceValue(def('branding.theme_tokens'), { light: { 'bad key': ';' } }).ok).toBe(false);
  });

  it('validates the team avatar against the DSL schema', () => {
    const ok = validateWorkspaceValue(def('branding.team_avatar'), {
      color: 'ocean',
      accessories: ['round-glasses'],
      leafStyle: 'big',
      faceStyle: 'sparkle',
      palette: { body: '#5ec4d6', leaf: '#3a8fa0' },
    });
    expect(ok.ok).toBe(true);
    const bad = validateWorkspaceValue(def('branding.team_avatar'), { palette: { body: 'blue', leaf: '#zzzzzz' } });
    expect(bad.ok).toBe(false);
  });
});
