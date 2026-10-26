#!/usr/bin/env node
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkCorePluginImports, checkPluginImports } from './lib/plugin-imports.mjs';

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', '.claude'].includes(entry.name)) return [];
    const file = join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : /\.[cm]?[jt]sx?$/.test(file) ? [file] : [];
  });
}
const violations = ['apps', 'packages', 'plugins'].flatMap(walk).flatMap((file) => {
  const text = readFileSync(file, 'utf8');
  return [...checkCorePluginImports(file, text), ...checkPluginImports(file, text)].map(
    (v) => `${file}:${v.line} ${v.specifier} — ${v.reason}`,
  );
});
if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else console.log('✓ plugin boundaries: core and packages use only allowed imports');
