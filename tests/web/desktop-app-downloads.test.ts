/**
 * Shell release index parsing (apps/web/src/lib/desktop/app-release.ts).
 *
 * downloads.json is fetched from the update source and rendered straight into the
 * settings download card, so the parser is the only thing standing between a
 * malformed publish and a broken/„download nothing" button.
 */
import { describe, expect, it } from 'vitest';
import {
  installerFor,
  isNewerRelease,
  parseAppDownloads,
  platformKey,
} from '../../apps/web/src/lib/desktop/app-release';

const valid = {
  schemaVersion: 1,
  version: '0.38.0',
  nativeApiVersion: '0.5.0',
  releasedAt: '2026-08-04T02:00:00.000Z',
  platforms: {
    'darwin-aarch64': {
      label: 'macOS (Apple Silicon)',
      url: 'https://greenhouse.example.com/updates/desktop/stable/app/Greenhouse-0.38.0-aarch64.dmg',
      sizeBytes: 18_874_368,
    },
  },
};

describe('parseAppDownloads', () => {
  it('accepts the shape make-app-release.mjs emits', () => {
    const parsed = parseAppDownloads(valid);
    expect(parsed?.version).toBe('0.38.0');
    expect(parsed?.nativeApiVersion).toBe('0.5.0');
    expect(parsed?.platforms['darwin-aarch64'].sizeBytes).toBe(18_874_368);
  });

  it.each([
    ['null', null],
    ['wrong schema version', { ...valid, schemaVersion: 2 }],
    ['missing platforms', { ...valid, platforms: {} }],
    ['non-https installer url', setUrl('http://greenhouse.example.com/x.dmg')],
    ['relative installer url', setUrl('/updates/desktop/stable/app/x.dmg')],
    ['zero size', { ...valid, platforms: { 'darwin-aarch64': { ...valid.platforms['darwin-aarch64'], sizeBytes: 0 } } }],
  ])('rejects %s', (_name, value) => {
    expect(parseAppDownloads(value)).toBeNull();
  });
});

function setUrl(url: string) {
  return { ...valid, platforms: { 'darwin-aarch64': { ...valid.platforms['darwin-aarch64'], url } } };
}

/**
 * What Settings → Desktop uses to decide whether to offer a shell update inside
 * the app. Getting either half wrong shows the wrong thing to everyone: a stale
 * "update available" that never goes away, or silence when one is genuinely due.
 */
describe('shell update availability', () => {
  const parsed = parseAppDownloads(valid)!;

  it('maps a running shell onto the key the release manifest publishes', () => {
    // DesktopInfo.platform is Rust's `macos`; the manifest uses the updater's `darwin`.
    expect(platformKey({ platform: 'macos', arch: 'aarch64' })).toBe('darwin-aarch64');
    expect(platformKey({ platform: 'windows', arch: 'x86_64' })).toBe('windows-x86_64');
  });

  it('finds the installer for this platform and nothing for others', () => {
    expect(installerFor(parsed, { platform: 'macos', arch: 'aarch64' })?.sizeBytes).toBe(18_874_368);
    // Windows builds exist but are not published — the card must not claim otherwise.
    expect(installerFor(parsed, { platform: 'windows', arch: 'x86_64' })).toBeNull();
  });

  it.each([
    ['a newer patch', '0.38.1', '0.38.0', true],
    ['a newer minor', '0.39.0', '0.38.9', true],
    ['a newer major', '1.0.0', '0.99.0', true],
    ['double-digit minors', '0.40.0', '0.9.0', true],
    ['the same version', '0.38.0', '0.38.0', false],
    ['an older release', '0.37.0', '0.38.0', false],
    ['an unreadable published version', 'nightly', '0.38.0', false],
    ['an unreadable installed version', '0.38.0', '', false],
  ])('%s → %s over %s is %s', (_name, published, installed, expected) => {
    expect(isNewerRelease(published, installed)).toBe(expected);
  });
});
