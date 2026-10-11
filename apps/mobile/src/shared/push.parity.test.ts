/**
 * Drift guard for the vendored push contract. apps/mobile sits outside the pnpm
 * workspace, so src/shared/push.ts is a verbatim copy of packages/types/src/push.ts
 * below its VENDORED header. If they differ, the phone and the server disagree about
 * what a push's `data` means (where a tap goes) or which switches a device has. Fix
 * by re-copying the canonical file — never by editing the copy.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');

describe('vendored push contract', () => {
  it('is byte-identical to the canonical module below its header', () => {
    const copy = read('apps/mobile/src/shared/push.ts');
    const header = copy.slice(0, copy.indexOf(' */\n\n') + ' */\n\n'.length);

    expect(header).toContain('VENDORED verbatim from packages/types/src/push.ts');
    expect(copy.slice(header.length)).toBe(read('packages/types/src/push.ts'));
  });
});
