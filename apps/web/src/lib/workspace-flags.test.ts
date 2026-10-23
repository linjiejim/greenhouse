import { describe, expect, it } from 'vitest';
import { flagChecked } from './workspace-flags';

describe('flagChecked', () => {
  const envOn = { value: null, flag: { effective: true, fallback: true } };
  const overriddenOff = { value: false, flag: { effective: false, fallback: true } };

  it('shows the value in effect, env and default included', () => {
    expect(flagChecked(envOn, undefined)).toBe(true);
    expect(flagChecked(overriddenOff, undefined)).toBe(false);
  });

  it('shows a staged value, and the fallback once the override is staged for clearing', () => {
    expect(flagChecked(envOn, false)).toBe(false);
    expect(flagChecked(overriddenOff, null)).toBe(true);
  });
});
