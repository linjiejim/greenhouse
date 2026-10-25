import { describe, expect, it } from 'vitest';
import { releaseTriple, satisfiesRange } from './semver.js';

describe('satisfiesRange', () => {
  it('handles the extension compat forms', () => {
    expect(satisfiesRange('3.0.0', '>=3.0 <4')).toBe(true);
    expect(satisfiesRange('3.7.2', '>=3.0 <4')).toBe(true);
    expect(satisfiesRange('4.0.0', '>=3.0 <4')).toBe(false);
    expect(satisfiesRange('2.9.9', '>=3.0 <4')).toBe(false);
    expect(satisfiesRange('3.2.0', '^3.1')).toBe(true);
    expect(satisfiesRange('3.0.9', '^3.1')).toBe(false);
    expect(satisfiesRange('4.0.0', '^3.1')).toBe(false);
    expect(satisfiesRange('0.2.5', '^0.2')).toBe(true);
    expect(satisfiesRange('0.3.0', '^0.2')).toBe(false);
  });

  it('counts a pre-release as its release', () => {
    expect(satisfiesRange('3.0.0-rc.3', '>=3.0 <4')).toBe(true);
    expect(satisfiesRange('v3.0.0-rc.3', '^3')).toBe(true);
    expect(satisfiesRange('4.0.0-rc.1', '>=3.0 <4')).toBe(false);
  });

  it('supports the rest of the grammar', () => {
    expect(satisfiesRange('3.1.4', '3.x')).toBe(true);
    expect(satisfiesRange('3.1.4', '*')).toBe(true);
    expect(satisfiesRange('3.1.4', '~3.1')).toBe(true);
    expect(satisfiesRange('3.2.0', '~3.1')).toBe(false);
    expect(satisfiesRange('3.1.4', '>= 3.1.4')).toBe(true);
    expect(satisfiesRange('3.1.4', '>3.1.4')).toBe(false);
    expect(satisfiesRange('3.1.4', '>3.0')).toBe(true);
    expect(satisfiesRange('3.0.9', '>3.0')).toBe(false);
    expect(satisfiesRange('3.1.4', '<=3.1')).toBe(true);
    expect(satisfiesRange('2.1.0', '^1 || ^2')).toBe(true);
    expect(satisfiesRange('3.1.4', '3.1.4')).toBe(true);
  });

  it('rejects garbage', () => {
    expect(() => satisfiesRange('three', '>=3')).toThrow(/Invalid version/);
    expect(() => satisfiesRange('3.0.0', '>=three')).toThrow(/Invalid version range/);
    expect(releaseTriple('3.0')).toEqual([3, 0, 0]);
    expect(releaseTriple('main-abc123')).toBeNull();
  });
});
