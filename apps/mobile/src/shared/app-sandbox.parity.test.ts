/**
 * Drift guard for the vendored custom-component sandbox contract (spec
 * 20261011-tables-apps-advanced §1, §7). apps/mobile sits outside the pnpm
 * workspace, so src/shared/app-sandbox.ts is a verbatim copy of
 * packages/types/src/app-sandbox.ts below its VENDORED header. If they differ,
 * the phone's WebView host and the web's iframe host speak different bridges.
 * Fix by re-copying the canonical file — never by editing the copy.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');

describe('vendored app-sandbox contract', () => {
  it('is byte-identical to the canonical module below its header', () => {
    const copy = read('apps/mobile/src/shared/app-sandbox.ts');
    const header = copy.slice(0, copy.indexOf(' */\n\n') + ' */\n\n'.length);

    expect(header).toContain('VENDORED verbatim from packages/types/src/app-sandbox.ts');
    expect(copy.slice(header.length)).toBe(read('packages/types/src/app-sandbox.ts'));
  });
});
