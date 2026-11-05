/** The asset library's `ui:build`: install the isolated ui-src project and bundle it into ui/dist (served at /ext/assets/ui/). */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const cwd = resolve(import.meta.dirname, '../ui-src');
for (const args of [
  ['install', '--ignore-workspace', '--frozen-lockfile'],
  ['--ignore-workspace', 'exec', 'vite', 'build', '--logLevel', 'warn'],
]) {
  const run = spawnSync('pnpm', args, { cwd, stdio: 'inherit' });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
