/**
 * Drift guard for the vendored Rich Output module. apps/mobile sits outside
 * the pnpm workspace, so src/shared/rich-output.ts is a verbatim copy of
 * packages/types/src/rich-output.ts below its VENDORED header. If they differ,
 * web and mobile judge the same model-authored block differently (that is how
 * mobile once drew charts the web had rejected). Fix by re-copying the
 * canonical file — never by editing the copy.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');

describe('vendored rich-output', () => {
  it('is byte-identical to the canonical module below its header', () => {
    const copy = read('apps/mobile/src/shared/rich-output.ts');
    const header = copy.slice(0, copy.indexOf(' */\n\n') + ' */\n\n'.length);

    expect(header).toContain('VENDORED verbatim from packages/types/src/rich-output.ts');
    expect(copy.slice(header.length)).toBe(read('packages/types/src/rich-output.ts'));
  });
});
