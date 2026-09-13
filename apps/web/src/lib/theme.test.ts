import { describe, expect, it } from 'vitest';
import { getThemeDefinition, normalizeThemeKey, resolveThemeKey, THEMES } from './theme.js';

describe('Greenhouse theme modes', () => {
  it('keeps exactly one light and one dark resolved palette', () => {
    expect(THEMES.map((theme) => theme.key)).toEqual(['light', 'dark']);
  });

  it('resolves the system preference without creating a third palette', () => {
    expect(resolveThemeKey('system', false)).toBe('light');
    expect(resolveThemeKey('system', true)).toBe('dark');
    expect(getThemeDefinition('system', true).key).toBe('dark');
  });

  it('keeps content canvas and application chrome distinct in both modes', () => {
    const light = getThemeDefinition('light').surface;
    const dark = getThemeDefinition('dark').surface;

    expect(light.canvas).toBe('#FFFFFF');
    expect(light.chrome).not.toBe(light.canvas);
    expect(light.surfaceCard).not.toBe(light.canvas);
    expect(light.surfaceCard).not.toBe(light.chrome);
    expect(dark.canvas).toBe(dark.surfaceSunken);
    expect(dark.chrome).toBe(dark.surfaceRaised);
    expect(dark.surfaceCard).toBe(dark.surfaceRaised);
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
