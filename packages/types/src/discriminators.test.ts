import { afterEach, describe, expect, it } from 'vitest';
import {
  assertDiscriminator,
  isRegisteredDiscriminator,
  registerDiscriminators,
  _resetDiscriminators,
} from './discriminators.js';
afterEach(_resetDiscriminators);
describe('persisted discriminator registry', () => {
  it('keeps core values and rejects an inactive plugin value', () => {
    expect(() => assertDiscriminator('runKinds', 'chat')).not.toThrow();
    expect(() => assertDiscriminator('fileLinkTargets', 'message')).not.toThrow();
    expect(() => assertDiscriminator('shareResources', 'ext:fixture:row')).toThrow('Unregistered');
  });
  it('opens every discriminator to an active fixture and forgets it on restart', () => {
    const values = {
      shareResources: ['ext:fixture:row'],
      fileLinkTargets: ['ext:fixture:row'],
      folderScopes: ['fixture'],
      auditApps: ['fixture'],
      runKinds: ['ext:fixture:sync'],
    };
    registerDiscriminators(values);
    for (const [key, items] of Object.entries(values))
      for (const value of items) expect(isRegisteredDiscriminator(key as keyof typeof values, value)).toBe(true);
    _resetDiscriminators();
    expect(isRegisteredDiscriminator('runKinds', 'ext:fixture:sync')).toBe(false);
  });
});
