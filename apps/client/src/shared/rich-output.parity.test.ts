/**
 * Drift guard for the vendored Rich Output module. apps/client sits outside the pnpm workspace,
 * so src/shared/rich-output.ts is a verbatim copy of packages/types/src/rich-output.ts below its
 * VENDORED header. If they differ, web and mobile judge the same model-authored block
 * differently. Fix by re-copying the canonical file — never by editing the copy. Skipped while the
 * canonical module predates the shared block registry (the 3.0 web lane brings it, spec B5).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');
const canonical = read('packages/types/src/rich-output.ts');

describe('vendored rich-output', () => {
  it.skipIf(!canonical.includes('export const RICH_BLOCKS'))('is byte-identical to the canonical module below its header', () => {
    const copy = read('apps/client/src/shared/rich-output.ts');
    const header = copy.slice(0, copy.indexOf(' */\n\n') + ' */\n\n'.length);
    expect(header).toContain('VENDORED verbatim from packages/types/src/rich-output.ts');
    expect(copy.slice(header.length)).toBe(canonical);
  });
});
