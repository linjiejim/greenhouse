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
  type Lock = { importers: Record<string, Record<string, string>>; snapshots: Record<string, Record<string, string>> };
  const BASE: Lock = {
    importers: { '.': { hono: '4.0.0' }, 'apps/api': { zod: '4.0.0' } },
    snapshots: { 'hono@4.0.0': {}, 'zod@4.0.0': { tslib: '2.0.0' }, 'tslib@2.0.0': {} },
  };
  const yaml = (lock: Lock) =>
    [
      "lockfileVersion: '9.0'",
      'settings:',
      '  autoInstallPeers: true',
      'importers:',
      ...Object.entries(lock.importers).flatMap(([key, deps]) => [
        `  ${key}:`,
        '    dependencies:',
        ...Object.entries(deps).map(
          ([name, version]) => `      ${name}: { specifier: '^${version}', version: ${version} }`,
        ),
      ]),
      'packages: {}',
      'snapshots:',
      ...Object.entries(lock.snapshots).flatMap(([key, deps]) =>
        Object.keys(deps).length
          ? [`  '${key}':`, '    dependencies:', ...Object.entries(deps).map(([n, v]) => `      ${n}: ${v}`)]
          : [`  '${key}': {}`],
      ),
      '',
    ].join('\n');
  function run(fork: Lock, uncommitted?: Lock): number {
    const dir = mkdtempSync(join(tmpdir(), 'overlay-lock-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q', '-b', 'upstream');
    git('config', 'user.email', 't@test.local');
    git('config', 'user.name', 'T');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), yaml(BASE));
    git('add', '.');
    git('commit', '-qm', 'upstream');
    git('checkout', '-qb', 'fork');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), yaml(fork));
    git('commit', '-qam', 'fork');
    if (uncommitted) writeFileSync(join(dir, 'pnpm-lock.yaml'), yaml(uncommitted));
    try {
      execFileSync('node', [script, '--base', 'upstream'], { cwd: dir, stdio: 'pipe' });
      return 0;
    } catch (error) {
      return (error as { status: number }).status;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const withPlugin: Lock = {
    importers: { ...BASE.importers, 'plugins/crm': { react: '19.0.0' } },
    snapshots: { ...BASE.snapshots, 'react@19.0.0': {} },
  };

  it('accepts a lockfile that only adds a private plugin importer and its packages', () => {
    expect(run(withPlugin)).toBe(0);
  });

  it('rejects a lockfile that changes a core importer', () => {
    expect(run({ ...BASE, importers: { ...BASE.importers, 'apps/api': { zod: '4.1.0' } } })).toBe(1);
  });

  it('rejects a lockfile that changes a package core installs, however deep', () => {
    expect(run({ ...withPlugin, snapshots: { ...withPlugin.snapshots, 'zod@4.0.0': { tslib: '2.9.9' } } })).toBe(1);
  });

  it('audits the committed lockfile, not the working tree', () => {
    const bad = { ...BASE, importers: { ...BASE.importers, 'apps/api': { zod: '4.1.0' } } };
    expect(run(bad, BASE)).toBe(1);
  });
});
