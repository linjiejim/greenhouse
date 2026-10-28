/** Export the isolated Expo workspace for same-origin API hosting. */
import { spawnSync } from 'node:child_process';
import { cpSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';
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
// The single-page export has no head template: add the site icons (copied from apps/client/public).
const index = join(target, 'index.html');
const html = readFileSync(index, 'utf8');
if (!html.includes('rel="manifest"'))
  writeFileSync(
    index,
    html.replace(
      '</head>',
      '<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest"></head>',
    ),
  );
// Brotli and gzip copies beside each text asset; apps/api/src/hosting.ts serves them by Accept-Encoding.
const COMPRESS = new Set(['.js', '.css', '.txt', '.json', '.svg', '.ttf']);
for (const entry of readdirSync(target, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !COMPRESS.has(extname(entry.name))) continue;
  const file = join(entry.parentPath, entry.name);
  const body = readFileSync(file);
  if (body.length < 1024) continue;
  writeFileSync(file + '.br', brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_SIZE_HINT]: body.length } }));
  writeFileSync(file + '.gz', gzipSync(body, { level: 9 }));
}
