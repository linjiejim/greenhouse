/**
 * The fork leak guard's glob matching.
 *
 * It shipped with `**` collapsing to a single level, so a nested extension file
 * (`apps/api/src/extensions/<id>/lib/client.ts`) read as a core edit. A guard
 * that is wrong in the permissive direction is worse than no guard; one that is
 * wrong in this direction cries wolf until someone switches it off.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dirname, '..', '..', 'scripts', 'check-extension-overlay.mjs'), 'utf8');
const globToRegExp = new Function(`return ${source.match(/function globToRegExp[\s\S]*?\n}/)![0]}`)() as (
  glob: string,
) => RegExp;

describe('check-extension-overlay glob matching', () => {
  it.each([
    ['apps/api/src/extensions/**', 'apps/api/src/extensions/index.ts', true],
    ['apps/api/src/extensions/**', 'apps/api/src/extensions/crm/index.ts', true],
    ['apps/api/src/extensions/**', 'apps/api/src/extensions/crm/lib/nested/deep.ts', true],
    ['apps/api/src/extensions/**', 'apps/api/src/tools/registry.ts', false],
    ['apps/web/src/extensions/**', 'apps/web/src/pages/chat.tsx', false],
    ['packs/**', 'packs/skills/brand/name/SKILL.md', true],
    ['deploy/**', 'deploy/README.md', true],
    ['.github/workflows/fork-*.yml', '.github/workflows/fork-ci.yml', true],
    ['.github/workflows/fork-*.yml', '.github/workflows/ci.yml', false],
    ['.github/workflows/fork-*.yml', '.github/workflows/fork/nested.yml', false],
    ['greenhouse.config.ts', 'greenhouse.config.ts', true],
    ['greenhouse.config.ts', 'apps/greenhouse.config.ts', false],
  ])('%s vs %s → %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });
});
