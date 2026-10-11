/**
 * Drift guard for the vendored mentions helpers: src/shared/mentions.ts is a verbatim copy of
 * packages/utils/src/mentions.ts below its VENDORED header — the one wire format of
 * `[@Name](user:<id>)` comment mentions. Fix drift by re-copying the canonical file.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');

describe('vendored mentions helpers', () => {
  it('are byte-identical to the canonical module below their header', () => {
    const copy = read('apps/mobile/src/shared/mentions.ts');
    const header = copy.slice(0, copy.indexOf(' */\n\n') + ' */\n\n'.length);

    expect(header).toContain('VENDORED verbatim from packages/utils/src/mentions.ts');
    expect(copy.slice(header.length)).toBe(read('packages/utils/src/mentions.ts'));
  });
});
