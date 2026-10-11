/**
 * Drift guard for the vendored table-cards contract (spec 20261011-mobile-tables-apps §1).
 * apps/mobile sits outside the pnpm workspace, so src/shared/table-cards.ts is a verbatim
 * copy of packages/types/src/table-cards.ts below its VENDORED header. If they differ, the
 * phone and the server disagree about a Tables / Apps wire shape. Fix by re-copying
 * the canonical file — never by editing the copy.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');

describe('vendored table-cards contract', () => {
  it('is byte-identical to the canonical module below its header', () => {
    const copy = read('apps/mobile/src/shared/table-cards.ts');
    const header = copy.slice(0, copy.indexOf(' */\n\n') + ' */\n\n'.length);

    expect(header).toContain('VENDORED verbatim from packages/types/src/table-cards.ts');
    expect(copy.slice(header.length)).toBe(read('packages/types/src/table-cards.ts'));
  });
});
