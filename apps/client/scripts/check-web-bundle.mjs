import process from 'node:process';
/** Inspect the real Metro graph, including lazy router context modules. */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(process.argv[2] ?? 'dist', '_expo/static/js/web');
const maps = (await readdir(root)).filter((name) => name.endsWith('.map'));
if (!maps.length) throw new Error('Export web with --source-maps before checking its native dependencies.');
const blocked = new Set();
for (const map of maps) {
  const { sources } = JSON.parse(await readFile(path.join(root, map), 'utf8'));
  for (const source of sources) if (/\/@expo\/ui\/src\/(swift-ui|jetpack-compose)\//.test(source)) blocked.add(source);
}
if (blocked.size) throw new Error(`Native form modules in web bundle:\n${[...blocked].join('\n')}`);
console.log(`Web dependency graph verified: ${maps.length} source map(s), zero SwiftUI / Compose modules.`);
