import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkExtensionCompat, EXTENSION_SDK, runningAppVersion } from '../compat.js';

describe('extension compatibility', () => {
  it('accepts a matching sdk and core range, including a release candidate', () => {
    expect(checkExtensionCompat({ id: 'x', sdk: EXTENSION_SDK, core: '>=3.0 <4' }, '3.0.0-rc.3')).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it('refuses a different sdk, a core range that does not match, and a malformed range', () => {
    expect(checkExtensionCompat({ id: 'x', sdk: EXTENSION_SDK + 1, core: '>=3' }, '3.1.0').errors[0]).toMatch(
      /written for extension sdk 3/,
    );
    expect(checkExtensionCompat({ id: 'x', sdk: EXTENSION_SDK, core: '>=4.0 <5' }, '3.1.0').errors[0]).toMatch(
      /supports Greenhouse >=4\.0 <5, but this is 3\.1\.0/,
    );
    expect(checkExtensionCompat({ id: 'x', sdk: EXTENSION_SDK, core: 'soon' }, '3.1.0').errors[0]).toMatch(
      /Invalid version range/,
    );
  });

  it('keeps SDK 1 plugins compatible throughout 4.x', () => {
    expect(checkExtensionCompat({ id: 'legacy', sdk: 1, core: '>=3 <5' }, '4.0.0').errors).toEqual([]);
  });

  it('only warns when the declarations are missing', () => {
    const result = checkExtensionCompat({ id: 'x' }, '3.0.0');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(2);
  });

  it('reads APP_VERSION, falling back to the root package.json for dev sentinels', () => {
    const root = mkdtempSync(join(tmpdir(), 'gh-compat-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '3.0.0-rc.3' }));
      expect(runningAppVersion({ APP_VERSION: 'v3.1.0' }, root)).toBe('3.1.0');
      expect(runningAppVersion({ APP_VERSION: '0.0.0-dev' }, root)).toBe('3.0.0-rc.3');
      expect(runningAppVersion({ APP_VERSION: 'main-abc123' }, root)).toBe('3.0.0-rc.3');
      expect(runningAppVersion({}, root)).toBe('3.0.0-rc.3');
      expect(runningAppVersion({}, join(root, 'missing'))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
