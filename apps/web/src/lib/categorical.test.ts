import { describe, expect, it } from 'vitest';
import { CATEGORICAL_CHOICES, categoricalColor, categoricalHex, categoricalName } from './categorical';

describe('categorical colours', () => {
  it('snaps the legacy saturated project colours onto the categorical hues', () => {
    expect(categoricalName('#3b82f6')).toBe('blue');
    expect(categoricalName('#8b5cf6')).toBe('purple');
    expect(categoricalName('#06b6d4')).toBe('teal');
    expect(categoricalName('#f59e0b')).toBe('amber');
    expect(categoricalName('#ef4444')).toBe('red');
    expect(categoricalName('#10b981')).toBe('green');
    expect(categoricalName('#ec4899')).toBe('pink');
  });

  it('keeps every offered colour on its own hue', () => {
    for (const name of CATEGORICAL_CHOICES) expect(categoricalName(categoricalHex(name))).toBe(name);
  });

  it('renders through the mode-aware variable, with a fallback when unset', () => {
    expect(categoricalColor('#ef4444')).toBe('var(--t-cat-red)');
    expect(categoricalColor('#777777')).toBe('var(--t-cat-gray)');
    expect(categoricalColor(null)).toBe('var(--t-fg-faint)');
  });
});
