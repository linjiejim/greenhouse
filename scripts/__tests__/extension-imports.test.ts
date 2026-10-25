import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs helper without type declarations
import { blankComments, checkFileImports, importViolation, parseImports } from '../lib/extension-imports.mjs';

const API = 'apps/api/src/extensions/crm/routes.ts';
const WEB = 'apps/web/src/extensions/crm/page.tsx';

describe('parseImports', () => {
  it('finds static, type-only, re-export, side-effect, dynamic and require imports with lines', () => {
    const text = [
      "import { a } from './a.js';",
      'import type {',
      '  B,',
      "} from '../../tools/define.js';",
      "export { c } from '@greenhouse/db';",
      "import './styles.css';",
      "const lazy = () => import('./page');",
      "const fs = require('node:fs');",
      "// import { nope } from '../../commented.js';",
      "/* import x from '../../block.js' */",
      "const s = \"import y from '../../in-a-string.js'\";",
      "const url = 'https://example.com//x'; import z from 'zod';",
    ].join('\n');
    expect(parseImports(text)).toEqual([
      { line: 1, specifier: './a.js' },
      { line: 4, specifier: '../../tools/define.js' },
      { line: 5, specifier: '@greenhouse/db' },
      { line: 6, specifier: './styles.css' },
      { line: 7, specifier: './page' },
      { line: 8, specifier: 'node:fs' },
      { line: 12, specifier: 'zod' },
    ]);
  });

  it('blanks comments but keeps strings and line numbers', () => {
    expect(blankComments("a // c\n'//'/* x\ny */b")).toBe("a     \n'//'    \n    b");
  });
});

describe('importViolation', () => {
  it('allows own files, sibling extensions, the kit, shared types/crud and third-party packages', () => {
    for (const spec of [
      './service.js',
      './sub/x.js',
      '../other-ext/client.js',
      '../../extension-kit.js',
      '@greenhouse/types/entity-links',
      '@greenhouse/types',
      '@greenhouse/crud',
      'zod',
      'drizzle-orm/pg-core',
      'node:crypto',
    ]) {
      expect(importViolation(API, spec), spec).toBeNull();
    }
    expect(importViolation(WEB, '../../extension-kit')).toBeNull();
  });

  it('reports core internals, the seam files and internal packages', () => {
    expect(importViolation(API, '../../auth/middleware.js')).toMatch(/reaches into core/);
    expect(importViolation(API, '../define.js')).toMatch(/seam internals/);
    expect(importViolation(API, '@greenhouse/db')).toMatch(/internal package/);
    expect(importViolation(API, '@greenhouse/platform-kernel')).toMatch(/internal package/);
    expect(importViolation(WEB, '../../components/ui')).toMatch(/reaches into core/);
    expect(importViolation(WEB, '../../../../api/src/extension-kit.js')).toMatch(/reaches into core/);
  });

  it('ignores files outside an extension directory', () => {
    expect(importViolation('apps/api/src/routes/mcp.ts', '@greenhouse/db')).toBeNull();
  });
});

describe('checkFileImports', () => {
  it('lists violations with lines and exempts test files', () => {
    const text = "import { getDb } from '@greenhouse/db';\nimport { x } from './x.js';\n";
    expect(checkFileImports(API, text)).toEqual([
      { line: 1, specifier: '@greenhouse/db', reason: expect.stringMatching(/internal package/) },
    ]);
    expect(checkFileImports('apps/api/src/extensions/crm/__tests__/a.test.ts', text)).toEqual([]);
    expect(checkFileImports('apps/api/src/extensions/crm/service.test.ts', text)).toEqual([]);
    expect(checkFileImports('apps/web/src/extensions/crm/e2e/flow.e2e.ts', text)).toEqual([]);
  });
});
