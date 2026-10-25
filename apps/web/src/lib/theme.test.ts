/** @vitest-environment happy-dom */

import { describe, expect, it } from 'vitest';
import {
  applyTheme,
  getThemeDefinition,
  normalizeThemeKey,
  resolveThemeKey,
  setThemeOverrideProvider,
  THEMES,
} from './theme.js';

describe('Greenhouse theme modes', () => {
  it('keeps exactly one light and one dark resolved palette', () => {
    expect(THEMES.map((theme) => theme.key)).toEqual(['light', 'dark']);
  });

  it('resolves the system preference without creating a third palette', () => {
    expect(resolveThemeKey('system', false)).toBe('light');
    expect(resolveThemeKey('system', true)).toBe('dark');
    expect(getThemeDefinition('system', true).key).toBe('dark');
  });

  it('switches appearance by class and writes no token values inline', () => {
    const root = document.documentElement;
    applyTheme('dark');
    expect(root.classList.contains('dark-theme')).toBe(true);
    expect(root.style.getPropertyValue('--t-surface-canvas')).toBe('');
    expect(root.style.getPropertyValue('--primary-500')).toBe('');
    applyTheme('light');
    expect(root.classList.contains('dark-theme')).toBe(false);
    expect(root.getAttribute('style') ?? '').not.toMatch(/--(t|primary)-/);
  });

  it('applies only Branding Studio overrides inline, and drops them on the next mode', () => {
    const root = document.documentElement;
    setThemeOverrideProvider((mode) => (mode === 'dark' ? { '--t-surface-canvas': '#000000' } : null));
    applyTheme('dark');
    expect(root.style.getPropertyValue('--t-surface-canvas')).toBe('#000000');
    applyTheme('light');
    expect(root.style.getPropertyValue('--t-surface-canvas')).toBe('');
    setThemeOverrideProvider(null);
  });

  it('migrates historical dark themes to dark', () => {
    expect(normalizeThemeKey('midnight')).toBe('dark');
    expect(normalizeThemeKey('deep-ocean')).toBe('dark');
    expect(normalizeThemeKey('amoled')).toBe('dark');
  });

  it('migrates historical light themes and defaults missing or unknown values to system', () => {
    expect(normalizeThemeKey('teal')).toBe('light');
    expect(normalizeThemeKey('forest')).toBe('light');
    expect(normalizeThemeKey('ocean')).toBe('light');
    expect(normalizeThemeKey('blossom')).toBe('light');
    expect(normalizeThemeKey('harvest')).toBe('light');
    expect(normalizeThemeKey('rose')).toBe('light');
    expect(normalizeThemeKey('anything-else')).toBe('system');
    expect(normalizeThemeKey(null)).toBe('system');
  });
});
