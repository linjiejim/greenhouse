/**
 * GUARD TEST — the API fork startup hook (bootstrap.extensions.ts).
 *
 * Upstream bootstrapForkExtensions() must be a no-op that never throws (the fork
 * populates its own copy). index.ts calls it at the start of main().
 */

import { describe, it, expect } from 'vitest';
import { bootstrapForkExtensions } from './bootstrap.extensions.js';

describe('fork bootstrap hook', () => {
  it('is a no-op upstream and does not throw', () => {
    expect(typeof bootstrapForkExtensions).toBe('function');
    expect(() => bootstrapForkExtensions()).not.toThrow();
  });
});
