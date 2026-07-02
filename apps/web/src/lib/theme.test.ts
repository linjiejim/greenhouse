/**
 * Theme mode normalization — including the one-time migration of stored keys
 * from the removed multi-theme palette (pre-2026-07) to light/dark.
 */

import { describe, it, expect } from 'vitest';
import { normalizeThemeMode } from './theme';

describe('normalizeThemeMode', () => {
  it('passes through the three canonical modes', () => {
    expect(normalizeThemeMode('light')).toBe('light');
    expect(normalizeThemeMode('dark')).toBe('dark');
    expect(normalizeThemeMode('system')).toBe('system');
  });

  it('maps legacy dark palette keys to dark', () => {
    for (const key of ['midnight', 'deep-ocean', 'amoled']) {
      expect(normalizeThemeMode(key)).toBe('dark');
    }
  });

  it('maps legacy light palette keys (and unknown values) to light', () => {
    for (const key of ['teal', 'forest', 'ocean', 'blossom', 'harvest', 'rose', 'whatever']) {
      expect(normalizeThemeMode(key)).toBe('light');
    }
  });

  it('defaults to system when nothing is stored', () => {
    expect(normalizeThemeMode(null)).toBe('system');
    expect(normalizeThemeMode('')).toBe('system');
  });
});
