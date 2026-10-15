/** Run after pnpm web:build. Check the shipped graph, not just a source-level import. */
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const root = new URL('../public/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('.vite/manifest.json', root), 'utf8'));
const [entry, chunk] = Object.entries(manifest).find(([, chunk]) => chunk.isEntry);
const initial = new Set();
function visit(key) {
  if (initial.has(key)) return;
  initial.add(key);
  for (const dependency of manifest[key].imports ?? []) visit(dependency);
}
visit(entry);
const bytes = (chunk) => statSync(new URL(chunk.file, root)).size;
assert(bytes(chunk) < 350_000, `Entry grew to ${bytes(chunk)} bytes (budget 350 KB)`);
for (const module of [
  'DocEditor.tsx',
  'BasePage.tsx',
  'AppBuilder.tsx',
  'rich/Chart.tsx',
  'rich/Mermaid.tsx',
  'ComputerScreenView.tsx',
]) {
  const key = Object.keys(manifest).find((key) => key.endsWith(module));
  assert(key, `Missing deferred module ${module}`);
  assert(!initial.has(key), `${module} is loaded by the entry's static graph`);
}
console.log(
  `Entry: ${bytes(chunk)} bytes; static JS graph: ${[...initial].reduce((total, key) => total + bytes(manifest[key]), 0)} bytes; six large modules deferred.`,
);
