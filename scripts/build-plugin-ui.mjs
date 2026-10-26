/** Build the example's dependency-free ES modules from the real ui-tokens package. */
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import ts from 'typescript';
const root = resolve(import.meta.dirname, '..');
const ui = join(root, 'plugins/example/ui');
const dist = join(ui, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'greenhouse'), { recursive: true });
for (const file of ['index.html', 'style.css', 'app.js']) cpSync(join(ui, file), join(dist, file));
for (const [source, target] of [
  ['packages/ui-tokens/src/index.ts', 'index.js'],
  ['packages/ui-tokens/src/tokens.generated.ts', 'tokens.generated.js'],
  ['packages/types/src/plugins.ts', 'protocol.js'],
]) {
  const text = readFileSync(join(root, source), 'utf8').replace("'@greenhouse/types/plugins'", "'./protocol.js'");
  writeFileSync(join(dist, 'greenhouse', target), ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText);
}
