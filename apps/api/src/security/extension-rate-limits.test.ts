import { afterEach, expect, it } from 'vitest';
import { registerExtensionRateLimits, extensionRateLimit } from './extension-rate-limits.js';
afterEach(() => registerExtensionRateLimits([]));
it('uses the closest contributed route and preserves internal limits without matching sibling prefixes', () => {
  registerExtensionRateLimits([
    { path: '/api/ext/fixture', windowMs: 60000, max: 10 },
    { path: '/api/ext/fixture/publish', windowMs: 60000, max: 2, internalMax: 20 },
  ]);
  expect(extensionRateLimit('/api/ext/fixture/publish')).toEqual({ windowMs: 60000, max: 2 });
  expect(extensionRateLimit('/api/ext/fixture/publish', true)).toEqual({ windowMs: 60000, max: 20 });
  expect(extensionRateLimit('/api/ext/fixture/notes')).toEqual({ windowMs: 60000, max: 10 });
  expect(extensionRateLimit('/api/ext/fixture-other')).toBeNull();
  registerExtensionRateLimits([]);
  expect(extensionRateLimit('/api/ext/fixture/publish')).toBeNull();
});
