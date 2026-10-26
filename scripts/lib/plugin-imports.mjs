/** Package boundaries apply equally to official and downstream plugins. */
import { builtinModules } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import ts from 'typescript';

const TEST = /(?:\.(?:test|spec|e2e)\.[cm]?[jt]sx?$|(?:^|\/)(?:__tests__|e2e)\/)/;
const BUILTINS = new Set(builtinModules.flatMap((id) => [id, `node:${id}`]));
const publicHost =
  /^(?:@greenhouse\/(?:api|web)\/extension-kit|@greenhouse\/types\/.+|@greenhouse\/crud|@greenhouse\/ui-tokens|@greenhouse\/knowledge-editor\/markdown|@greenhouse\/ui\/.+)$/;
const packageName = (id) => (id.startsWith('@') ? id.split('/').slice(0, 2).join('/') : id.split('/')[0]);

/** AST parsing covers imports, re-exports, import types, require and dynamic imports. */
export function moduleImports(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports = [];
  const add = (node) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    imports.push({ line, specifier: ts.isStringLiteralLike(node) ? node.text : null });
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
      add(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression
    )
      add(node.moduleReference.expression);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      if (node.arguments[0]) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

export function checkPluginImports(file, text, root = process.cwd()) {
  const match = /^plugins\/([^/]+)\//.exec(file);
  if (!match || TEST.test(file)) return [];
  const own = `plugins/${match[1]}`;
  const pkg = JSON.parse(readFileSync(resolve(root, own, 'package.json'), 'utf8'));
  // The manifest is data, so inspect it without evaluating plugin code in lint.
  const manifestFile = ['manifest.ts', 'manifest.js'].map((name) => resolve(root, own, name)).find(existsSync);
  const source =
    manifestFile && ts.createSourceFile(manifestFile, readFileSync(manifestFile, 'utf8'), ts.ScriptTarget.Latest, true);
  const dependsOn = new Set();
  function visit(node) {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source).replace(/['"]/g, '') === 'dependsOn' &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const value of node.initializer.elements) if (ts.isStringLiteralLike(value)) dependsOn.add(value.text);
    }
    ts.forEachChild(node, visit);
  }
  if (source) visit(source);
  const dependencies = new Set(
    Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }),
  );
  const pluginPackages = new Map();
  const pluginsRoot = resolve(root, 'plugins');
  for (const folder of readdirSync(pluginsRoot)) {
    const file = resolve(pluginsRoot, folder, 'package.json');
    if (!existsSync(file)) continue;
    const metadata = JSON.parse(readFileSync(file, 'utf8'));
    if (metadata.greenhouse) pluginPackages.set(metadata.name, metadata.greenhouse.id);
  }
  return moduleImports(file, text).flatMap(({ line, specifier }) => {
    let reason;
    if (specifier === null) reason = 'computed module imports cannot be checked';
    else if (specifier.startsWith('.')) {
      const target = posix.normalize(posix.join(posix.dirname(file), specifier));
      if (!(target === own || target.startsWith(own + '/'))) reason = 'relative import escapes plugin directory';
    } else if (publicHost.test(specifier) || BUILTINS.has(specifier) || packageName(specifier) === pkg.name) return [];
    else {
      const name = packageName(specifier);
      let pluginId = pluginPackages.get(name);
      if (!pluginId) {
        try {
          pluginId = JSON.parse(readFileSync(resolve(root, own, 'node_modules', name, 'package.json'), 'utf8'))
            .greenhouse?.id;
        } catch {
          /* external dependency may not be installed yet */
        }
      }
      if (pluginId && (!dependsOn.has(pluginId) || !dependencies.has(name)))
        reason = 'plugin dependency must be in dependsOn and package.json';
      else if (!pluginId && name.startsWith('@greenhouse/')) reason = 'internal host package — use an extension kit';
      else if (!dependencies.has(name)) reason = 'package is not declared in this plugin package.json';
    }
    return reason ? [{ line, specifier: specifier ?? '<computed>', reason }] : [];
  });
}

export function checkCorePluginImports(file, text) {
  if (!/^(apps|packages)\//.test(file) || /^apps\/(api|web)\/src\/extensions\/compiled\.generated\.ts$/.test(file))
    return [];
  return moduleImports(file, text)
    .filter(({ specifier }) => {
      if (!specifier) return false;
      const target = specifier.startsWith('.')
        ? posix.normalize(posix.join(posix.dirname(file), specifier))
        : specifier;
      return (
        target.startsWith('plugins/') ||
        (target.startsWith('/') && target.includes('/plugins/')) ||
        target.startsWith('@greenhouse/plugin-')
      );
    })
    .map((entry) => ({ ...entry, reason: 'core must not import plugin code; configure the package instead' }));
}
