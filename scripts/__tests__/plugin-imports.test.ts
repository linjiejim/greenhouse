import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error mjs guard is also directly runnable by Node
import { checkCorePluginImports, checkPluginImports } from '../lib/plugin-imports.mjs';
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gh-boundaries-'));
  for (const id of ['fixture', 'dependency']) {
    mkdirSync(join(root, 'plugins', id), { recursive: true });
    writeFileSync(
      join(root, 'plugins', id, 'package.json'),
      JSON.stringify({
        name: `@private/${id}`,
        greenhouse: { id },
        dependencies: { zod: '*', '@private/dependency': '*' },
      }),
    );
    writeFileSync(join(root, 'plugins', id, 'manifest.ts'), "export default { dependsOn: ['dependency'] };");
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const file = 'plugins/fixture/api/index.ts';
function check(spec: string) {
  return checkPluginImports(file, `export * from '${spec}';`, root);
}
describe('package import boundaries', () => {
  it('permits kits, shared types/UI, own files and declared dependencies', () => {
    for (const spec of [
      '@greenhouse/api/extension-kit',
      '@greenhouse/types/api',
      '@greenhouse/crud',
      './own.js',
      '../manifest.js',
      '@private/dependency/api',
      'zod',
      'node:fs',
    ])
      expect(check(spec)).toEqual([]);
  });
  it('rejects core deep imports, escaping paths and undeclared dependencies', () => {
    for (const spec of [
      '@greenhouse/db',
      '@greenhouse/api/src/auth',
      '@greenhouse/types',
      '../../../apps/api/src/auth.js',
      '../../dependency/api.js',
      'unlisted',
      '@greenhouse/crud/server',
    ])
      expect(check(spec)).toHaveLength(1);
    writeFileSync(join(root, 'plugins/fixture/manifest.ts'), 'export default { dependsOn: [] };');
    expect(check('@private/dependency')).toHaveLength(1);
  });
  it('checks dynamic imports, import types and re-exports while ignoring strings and comments', () => {
    const text =
      "import type X = require('@greenhouse/db'); type T = import('@greenhouse/db').Db; const x = import('@greenhouse/db'); export * from '@greenhouse/db';";
    expect(checkPluginImports(file, text, root)).toHaveLength(4);
    expect(checkPluginImports(file, 'const x = import(variable);', root)).toHaveLength(1);
    expect(
      checkPluginImports(file, "// import x from '@greenhouse/db';\nconst text = `import('@greenhouse/db')`;", root),
    ).toEqual([]);
  });
  it('forbids core-to-plugin imports except in the generated registration', () => {
    for (const path of ['apps/api/src/x.ts', 'apps/client/src/x.ts', 'packages/utils/src/x.ts']) {
      for (const spec of ['@greenhouse/plugin-fixture/api', '../../../plugins/fixture/api/index.js'])
        expect(checkCorePluginImports(path, `import x from '${spec}';`)).toHaveLength(1);
    }
    expect(
      checkCorePluginImports(
        'apps/api/src/plugin-host/compiled.generated.ts',
        "import x from '../../../../plugins/fixture/api/index.js';",
      ),
    ).toEqual([]);
  });
  it('retains the existing test-only host-hook exemption', () => {
    expect(
      checkPluginImports('plugins/fixture/api/__tests__/x.test.ts', "import x from '@greenhouse/db';", root),
    ).toEqual([]);
  });
});
