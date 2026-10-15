import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = new URL('../../', import.meta.url).pathname;
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() && entry.name !== 'node_modules'
      ? files(join(dir, entry.name))
      : entry.isFile() && /\.tsx?$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );
}
function imports(source: string) {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    )
      found.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      found.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  return found;
}
const implementation = (path: string) => {
  const tail = /(?:^|\/)extensions\/(.+)$/.exec(path)?.[1];
  return !!tail && !/^(?:host|define|index|registry)(?:\.[jt]sx?)?$/.test(tail) && !tail.startsWith('__tests__/');
};

it('core never imports extension implementations, including dynamic imports and re-exports', () => {
  const leaks: string[] = [];
  for (const path of [
    ...files(join(root, 'apps/api/src')),
    ...files(join(root, 'apps/web/src')),
    ...files(join(root, 'packages')),
  ]) {
    const name = relative(root, path);
    if (
      implementation(name) ||
      name.includes('/__tests__/') ||
      /apps\/(api|web)\/src\/extensions\/index\.ts$/.test(name)
    )
      continue;
    for (const specifier of imports(readFileSync(path, 'utf8'))) {
      const target = specifier.startsWith('.') ? resolve(path, '..', specifier) : specifier;
      if (implementation(target)) leaks.push(`${name}: ${specifier}`);
    }
  }
  expect(leaks).toEqual([]);
  expect(
    imports(
      `import type { A } from './extensions/private/a'; export * from './extensions/private/b'; const x = import('./extensions/private/c'); require('./extensions/private/d');`,
    ),
  ).toHaveLength(4);
});
