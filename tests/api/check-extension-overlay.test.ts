/**
 * The fork leak guard's glob matching.
 *
 * It shipped with `**` collapsing to a single level, so a nested extension file
 * (`plugins/<id>/api/lib/client.ts`) read as a core edit. A guard
 * that is wrong in the permissive direction is worse than no guard; one that is
 * wrong in this direction cries wolf until someone switches it off.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dirname, '..', '..', 'scripts', 'check-extension-overlay.mjs'), 'utf8');
const globToRegExp = new Function(`return ${source.match(/function globToRegExp[\s\S]*?\n}/)![0]}`)() as (
  glob: string,
) => RegExp;

describe('check-extension-overlay glob matching', () => {
  it.each([
    ['plugins/**', 'plugins/crm/index.ts', true],
    ['plugins/**', 'plugins/crm/api/lib/nested/deep.ts', true],
    ['plugins/**', 'apps/api/src/tools/registry.ts', false],
    ['plugins/**', 'apps/api/src/plugin-host/index.ts', false],
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

describe('check-extension-overlay lockfile rule', () => {
  const script = join(import.meta.dirname, '..', '..', 'scripts', 'check-extension-overlay.mjs');
  const lock = (importers: Record<string, unknown>) =>
    `lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\nimporters:\n${Object.entries(importers)
      .map(([key, value]) => `  ${key}:\n    dependencies: ${JSON.stringify(value)}`)
      .join('\n')}\npackages: {}\n`;
  function run(change: Record<string, unknown>): number {
    const dir = mkdtempSync(join(tmpdir(), 'overlay-lock-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q', '-b', 'upstream');
    git('config', 'user.email', 't@test.local');
    git('config', 'user.name', 'T');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), lock({ '.': { a: 1 }, 'apps/api': { b: 1 } }));
    git('add', '.');
    git('commit', '-qm', 'upstream');
    git('checkout', '-qb', 'fork');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), lock({ '.': { a: 1 }, 'apps/api': { b: 1 }, ...change }));
    git('commit', '-qam', 'fork');
    try {
      execFileSync('node', [script, '--base', 'upstream'], { cwd: dir, stdio: 'pipe' });
      return 0;
    } catch (error) {
      return (error as { status: number }).status;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('accepts a lockfile that only adds a private plugin importer', () => {
    expect(run({ 'plugins/crm': { c: 1 } })).toBe(0);
  });

  it('rejects a lockfile that changes a core importer', () => {
    expect(run({ 'apps/api': { b: 2 } })).toBe(1);
  });
});
