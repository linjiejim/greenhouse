import { describe, it, expect } from 'vitest';
import { parseSemver, isValidSemver, compareSemver, bumpPatch } from './semver.js';

describe('parseSemver / isValidSemver', () => {
  it('parses strict X.Y.Z', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver('0.0.0')).toEqual({ major: 0, minor: 0, patch: 0 });
    expect(parseSemver('10.20.30')).toEqual({ major: 10, minor: 20, patch: 30 });
  });

  it('rejects tags, leading zeros, partial and garbage versions', () => {
    for (const bad of ['1.2', '1', '1.2.3-beta', '1.2.3+build', 'v1.2.3', '01.2.3', '1.02.3', '1.2.3.4', '', 'a.b.c']) {
      expect(isValidSemver(bad), bad).toBe(false);
      expect(parseSemver(bad), bad).toBeNull();
    }
  });
});

describe('compareSemver', () => {
  it('orders numerically per part (not lexically)', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.10', '1.2.9')).toBeGreaterThan(0);
    expect(compareSemver('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareSemver('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareSemver('0.1.0', '0.2.0')).toBeLessThan(0);
  });

  it('throws on invalid input', () => {
    expect(() => compareSemver('1.2', '1.2.3')).toThrow(/Invalid semver/);
    expect(() => compareSemver('1.2.3', 'nope')).toThrow(/Invalid semver/);
  });
});

describe('bumpPatch', () => {
  it('increments the patch part', () => {
    expect(bumpPatch('0.1.0')).toBe('0.1.1');
    expect(bumpPatch('1.2.9')).toBe('1.2.10');
  });

  it('throws on invalid input', () => {
    expect(() => bumpPatch('1.2.3-beta')).toThrow(/Invalid semver/);
  });
});
