/**
 * Shell-release manifest assembly (scripts/desktop/app-release-manifests.mjs).
 *
 * latest.json is what every installed shell trusts for its next binary, so the
 * shapes here are wire contracts: the tauri-plugin-updater schema on one side and
 * the web download card + publish idempotency check on the other. Since the
 * Windows tier-1 release (spec 20260814) both documents carry every published
 * platform in one map — and on Windows the signed NSIS installer is both the
 * browser download and the updater payload, so both URLs must agree.
 */
import { describe, expect, it } from 'vitest';
import {
  appFileStem,
  artifactBaseFor,
  buildAppReleaseManifests,
  platformArtifactNames,
  // @ts-expect-error plain .mjs module without type declarations
} from '../scripts/desktop/app-release-manifests.mjs';

const UPDATE_BASE_URL = 'https://greenhouse.example.com:18888/updates/desktop';

const darwin = {
  platformKey: 'darwin-aarch64',
  updaterSig: 'dW50cnVzdGVkIGNvbW1lbnQ...\n',
  installerSizeBytes: 18_874_368,
};

const windows = {
  platformKey: 'windows-x86_64',
  updaterSig: 'd2luZG93cy1zaWc...\n',
  installerSizeBytes: 5_242_880,
};

const valid = {
  version: '0.38.0',
  nativeApiVersion: '0.5.0',
  channel: 'stable',
  artifactBaseUrl: artifactBaseFor(UPDATE_BASE_URL, 'stable'),
  releasedAt: '2026-08-04T02:00:00.000Z',
  notes: '托盘菜单 — Greenhouse 0.38.0',
  platforms: [darwin, windows],
};

describe('buildAppReleaseManifests', () => {
  it('emits the tauri updater schema with every platform in one document', () => {
    const { latest } = buildAppReleaseManifests(valid);
    expect(latest).toEqual({
      version: '0.38.0',
      notes: '托盘菜单 — Greenhouse 0.38.0',
      pub_date: '2026-08-04T02:00:00.000Z',
      platforms: {
        'darwin-aarch64': {
          signature: 'dW50cnVzdGVkIGNvbW1lbnQ...',
          url: `${UPDATE_BASE_URL}/stable/app/Greenhouse-0.38.0-aarch64.app.tar.gz`,
        },
        'windows-x86_64': {
          signature: 'd2luZG93cy1zaWc...',
          url: `${UPDATE_BASE_URL}/stable/app/Greenhouse-0.38.0-x86_64-setup.exe`,
        },
      },
    });
  });

  it('emits the downloads index with per-platform installers and the native API line', () => {
    const { downloads } = buildAppReleaseManifests(valid);
    expect(downloads).toEqual({
      schemaVersion: 1,
      version: '0.38.0',
      nativeApiVersion: '0.5.0',
      releasedAt: '2026-08-04T02:00:00.000Z',
      platforms: {
        'darwin-aarch64': {
          label: 'macOS (Apple Silicon)',
          url: `${UPDATE_BASE_URL}/stable/app/Greenhouse-0.38.0-aarch64.dmg`,
          sizeBytes: 18_874_368,
        },
        'windows-x86_64': {
          label: 'Windows (x64)',
          url: `${UPDATE_BASE_URL}/stable/app/Greenhouse-0.38.0-x86_64-setup.exe`,
          sizeBytes: 5_242_880,
        },
      },
    });
  });

  it('points the windows updater and download at the same signed installer', () => {
    const { latest, downloads } = buildAppReleaseManifests(valid);
    expect(latest.platforms['windows-x86_64'].url).toBe(downloads.platforms['windows-x86_64'].url);
  });

  it('routes beta channel urls under /beta/app/', () => {
    const { latest, downloads } = buildAppReleaseManifests({
      ...valid,
      channel: 'beta',
      artifactBaseUrl: artifactBaseFor(UPDATE_BASE_URL, 'beta'),
    });
    expect(latest.platforms['darwin-aarch64'].url).toContain('/beta/app/');
    expect(downloads.platforms['windows-x86_64'].url).toContain('/beta/app/');
  });

  it('points at a release host when the artifacts are parked elsewhere', () => {
    const { latest, downloads } = buildAppReleaseManifests({
      ...valid,
      artifactBaseUrl: 'https://github.com/example/greenhouse/releases/download/v0.38.0/',
    });
    expect(latest.platforms['darwin-aarch64'].url).toBe(
      'https://github.com/example/greenhouse/releases/download/v0.38.0/Greenhouse-0.38.0-aarch64.app.tar.gz',
    );
    expect(downloads.platforms['windows-x86_64'].url).toBe(
      'https://github.com/example/greenhouse/releases/download/v0.38.0/Greenhouse-0.38.0-x86_64-setup.exe',
    );
  });

  it('labels intel builds distinctly', () => {
    const { downloads } = buildAppReleaseManifests({
      ...valid,
      platforms: [{ ...darwin, platformKey: 'darwin-x86_64' }],
    });
    expect(downloads.platforms['darwin-x86_64'].label).toBe('macOS (Intel)');
  });

  it.each([
    ['version', { version: 'v1' }, /version must be semver/],
    ['nativeApiVersion', { nativeApiVersion: '5' }, /nativeApiVersion must be semver/],
    ['channel', { channel: 'nightly' }, /channel must be one of/],
    ['artifact base', { artifactBaseUrl: 'updates/app' }, /artifactBaseUrl must be an http\(s\) URL/],
    ['releasedAt', { releasedAt: 'yesterday' }, /releasedAt/],
    ['empty platforms', { platforms: [] }, /non-empty array/],
    ['platform key', { platforms: [{ ...darwin, platformKey: 'linux-x86_64' }] }, /unsupported platform/],
    ['signature', { platforms: [{ ...darwin, updaterSig: '  \n' }] }, /updaterSig for darwin-aarch64 is empty/],
    ['installer size', { platforms: [{ ...windows, installerSizeBytes: 0 }] }, /installerSizeBytes/],
    ['duplicate platform', { platforms: [darwin, darwin] }, /duplicate platform/],
  ])('rejects invalid %s', (_name, patch, message) => {
    expect(() => buildAppReleaseManifests({ ...valid, ...patch })).toThrow(message);
  });

  it('keeps file stems collision-free across versions and arches', () => {
    expect(appFileStem('0.38.0', 'aarch64')).toBe('Greenhouse-0.38.0-aarch64');
    expect(appFileStem('0.38.1', 'x86_64')).toBe('Greenhouse-0.38.1-x86_64');
  });
});

describe('platformArtifactNames', () => {
  it('keeps macOS updater payload and installer distinct', () => {
    expect(platformArtifactNames('darwin-aarch64', '0.53.0')).toEqual({
      installer: 'Greenhouse-0.53.0-aarch64.dmg',
      updater: 'Greenhouse-0.53.0-aarch64.app.tar.gz',
      updaterSigFile: 'Greenhouse-0.53.0-aarch64.app.tar.gz.sig',
    });
  });

  it('uses the one signed installer for both roles on windows', () => {
    expect(platformArtifactNames('windows-x86_64', '0.53.0')).toEqual({
      installer: 'Greenhouse-0.53.0-x86_64-setup.exe',
      updater: 'Greenhouse-0.53.0-x86_64-setup.exe',
      updaterSigFile: 'Greenhouse-0.53.0-x86_64-setup.exe.sig',
    });
  });

  it('rejects platforms the release pipeline does not publish', () => {
    expect(() => platformArtifactNames('linux-x86_64', '0.53.0')).toThrow(/unsupported platform/);
  });
});
