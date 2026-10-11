/**
 * The Tables / Apps contracts the mobile app vendors verbatim (spec
 * 20261011-mobile-tables-apps §1) must stay copyable: no package imports and no
 * runtime imports — only `import type` from sibling contract files, which the
 * app vendors next to them.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const VENDORED_TYPE_ONLY = ['tables-wire.ts', 'apps.ts', 'app-sandbox.ts'];

function importLines(file: string): string[] {
  const text = readFileSync(resolve(__dirname, '..', file), 'utf8');
  return [...text.matchAll(/^import[\s\S]*?from\s+'([^']+)';/gm)].map((match) => match[0]);
}

describe('vendored Tables / Apps contracts', () => {
  it.each(VENDORED_TYPE_ONLY)('%s imports only types, only from sibling files', (file) => {
    const lines = importLines(file);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^import type /);
      expect(line).toMatch(/from '\.\/[a-z-]+\.js';$/);
    }
  });
});
