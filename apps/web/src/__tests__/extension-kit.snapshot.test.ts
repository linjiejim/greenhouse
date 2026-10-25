/**
 * The web extension kit is the stable surface overlays build against. Removing
 * or renaming an export breaks them: update this snapshot only together with a
 * CHANGELOG line starting `extension-kit:` (see EXTENDING.md).
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { kitExportNames } from '../../../../tests/helpers/kit-exports.js';

describe('apps/web extension-kit', () => {
  it('exports exactly the documented names', { timeout: 120_000 }, () => {
    const names = kitExportNames(
      fileURLToPath(new URL('../extension-kit.ts', import.meta.url)),
      fileURLToPath(new URL('../../tsconfig.json', import.meta.url)),
    );
    expect(names).toMatchSnapshot();
  });
});
