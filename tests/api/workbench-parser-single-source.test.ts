/**
 * Guard: workbench config parsing stays in one place.
 *
 * The database service, the API validator and the browser all read the same
 * stored blob. Before this feature each maintained its own hand-written
 * whitelist and they had already diverged; the fix only holds if nobody
 * re-introduces a local parser, which is what this test pins.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

/** The three consumers that must delegate to `@greenhouse/types/workbench`. */
const CONSUMERS = [
  'packages/db/src/services/platform.ts',
  'apps/api/src/routes/platform.ts',
  'apps/web/src/platform/catalog.ts',
];

describe('workbench config parsing', () => {
  it('is delegated to the shared parser by every consumer', () => {
    const missing = CONSUMERS.filter((path) => {
      const source = readFileSync(join(ROOT, path), 'utf8');
      return !/from\s+['"]@greenhouse\/types\/workbench['"]/.test(source) || !/parseWorkbenchConfig/.test(source);
    });
    expect(missing).toEqual([]);
  });

  it('has no consumer normalizing preference fields on its own', () => {
    // The exact line that used to exist in all three places, each with its own
    // idea of the fallback. Delegating wrappers are fine; re-deriving a field
    // value is what drifts.
    const densityFallback = /density:\s*[^,\n]*['"]compact['"]\s*\?\s*['"]compact['"]/;
    const offenders = CONSUMERS.filter((path) => densityFallback.test(readFileSync(join(ROOT, path), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
