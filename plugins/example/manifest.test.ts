import { describe, expect, it } from 'vitest';
import manifest from './manifest.js';
import { exampleExtension } from './api/index.js';
import { checkExtensionCompat, runningAppVersion } from '../../apps/api/src/extensions/compat.js';

describe('example package manifest', () => {
  it('is pure data shared by its code half and compatible with this core', () => {
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
    expect(exampleExtension).toMatchObject({
      id: manifest.id,
      sdk: manifest.sdk,
      core: manifest.core,
      version: manifest.version,
    });
    expect(checkExtensionCompat(exampleExtension, runningAppVersion())).toEqual({ errors: [], warnings: [] });
  });
});
