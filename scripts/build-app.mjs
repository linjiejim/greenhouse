/** Export the isolated Expo workspace for same-origin API hosting. */
import { spawnSync } from 'node:child_process';
import { cpSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const mobile = join(root, 'apps/client');
const output = join(mobile, 'dist-hosted');
const env = { ...process.env, CI: 'true', EXPO_NO_DOTENV: '1', EXPO_PUBLIC_STATIONS_MODE: 'single' };
// A hosted browser build always connects to its own origin, never a developer's station.
for (const key of ['GREENHOUSE_DESKTOP', 'EXPO_PUBLIC_API_BASE_URL', 'EXPO_PUBLIC_STATION_NAME']) delete env[key];
const result = spawnSync('pnpm', ['exec', 'expo', 'export', '-p', 'web', '--output-dir', output], { cwd: mobile, env, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(join(output, 'index.html'))) throw new Error('Expo export is missing index.html');
const target = join(root, 'public/app');
rmSync(target, { recursive: true, force: true });
cpSync(output, target, { recursive: true });
