import { describe, it, expect } from 'vitest';
// The packaging helper is plain ESM (no TS) so both the build script and this
// test import the same source of truth for tag → manifest-version normalisation.
import { toManifestVersion } from '../../apps/browser/scripts/manifest-version.mjs';

describe('toManifestVersion', () => {
  it('strips the leading v', () => {
    expect(toManifestVersion('v0.2.0')).toBe('0.2.0');
  });

  it('drops prerelease and build metadata (Chrome wants numeric parts only)', () => {
    expect(toManifestVersion('v1.4.0-rc.1')).toBe('1.4.0');
    expect(toManifestVersion('0.3.2+build.5')).toBe('0.3.2');
  });

  it('accepts a plain dotted version', () => {
    expect(toManifestVersion('2.10.3')).toBe('2.10.3');
  });

  it('caps at four numeric segments', () => {
    expect(toManifestVersion('1.2.3.4.5')).toBe('1.2.3.4');
  });

  it('returns null for empty / unusable input so the built manifest is kept', () => {
    expect(toManifestVersion(undefined)).toBeNull();
    expect(toManifestVersion('')).toBeNull();
    expect(toManifestVersion('edge')).toBeNull();
  });
});
