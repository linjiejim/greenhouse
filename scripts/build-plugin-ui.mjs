/**
 * Build every compiled plugin's static UI: a plugin opts in with a `ui:build` script in its
 * package.json, which writes `ui/dist` (served ahead of `ui/`). Runs at install, dev, API start
 * and in the image build; a failing build stops it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolvePlugins } from './plugins-sync.mjs';

const only = process.argv.slice(2);
for (const plugin of await resolvePlugins()) {
  if (only.length && !only.includes(plugin.id)) continue;
  const pkg = JSON.parse(readFileSync(join(plugin.dir, 'package.json'), 'utf8'));
  if (!pkg.scripts?.['ui:build']) continue;
  const run = spawnSync('pnpm', ['--dir', plugin.dir, 'run', '--silent', 'ui:build'], { stdio: 'inherit' });
  if (run.status !== 0) {
    console.error(`plugins:ui:build: ${plugin.id} failed`);
    process.exit(run.status ?? 1);
  }
}
