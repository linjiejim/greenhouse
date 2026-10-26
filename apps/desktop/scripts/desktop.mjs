#!/usr/bin/env node
import { buildDmg } from './build-dmg.mjs';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const root = resolve(fileURLToPath(import.meta.url), '../../../..');
const desktop = join(root, 'apps/desktop'),
  mobile = join(root, 'apps/mobile');
const env = {
  ...process.env,
  CARGO_HOME: join(root, '.cargo-home'),
  CARGO_TARGET_DIR: join(desktop, 'src-tauri/target'),
  npm_config_cache: join(root, '.cargo-home/npm'),
  CI: 'true',
  GREENHOUSE_DESKTOP: '1',
  EXPO_PUBLIC_STATIONS_MODE: 'multi',
  EXPO_NO_DOTENV: '1',
};
// A generic desktop build must not inherit the browser test station or mobile station lock.
delete env.EXPO_PUBLIC_API_BASE_URL;
delete env.EXPO_PUBLIC_STATION_NAME;
mkdirSync(env.CARGO_HOME, { recursive: true });
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const mode = process.argv[2];
if (!['dev', 'build', 'check', 'export'].includes(mode)) throw new Error('Expected dev, build, check or export');
const config = JSON.parse(readFileSync(join(desktop, 'src-tauri/tauri.conf.json'), 'utf8'));
const endpoint = process.env.GREENHOUSE_UPDATER_ENDPOINT?.trim();
env.GREENHOUSE_UPDATER_ENDPOINT = endpoint || '';
if (!process.env.GREENHOUSE_DESKTOP_SIGNING_IDENTITY) {
  for (const key of Object.keys(env)) if (key.startsWith('APPLE_')) delete env[key];
}
if (endpoint) {
  if (!endpoint.startsWith('https://')) throw new Error('GREENHOUSE_UPDATER_ENDPOINT must use HTTPS');
  config.plugins.updater.endpoints = [endpoint];
  config.bundle.createUpdaterArtifacts = true;
}
// Signing is deliberately opt-in. Empty Apple variables on a developer machine are ignored.
if (process.env.GREENHOUSE_DESKTOP_SIGNING_IDENTITY)
  config.bundle.macOS.signingIdentity = process.env.GREENHOUSE_DESKTOP_SIGNING_IDENTITY;
const overlay = join(desktop, '.tauri-build.json');
writeFileSync(overlay, JSON.stringify(config, null, 2));
if (mode === 'check') {
  run('pnpm', ['exec', 'expo', 'export', '-p', 'web', '--output-dir', '../desktop/dist', '--source-maps'], mobile);
  run('node', ['scripts/check-web-bundle.mjs', join(desktop, 'dist')], mobile);
  run('node', [join(desktop, 'scripts/check-export.mjs'), join(desktop, 'dist')]);
  run('cargo', ['fmt', '--manifest-path', join(desktop, 'src-tauri/Cargo.toml'), '--check']);
  run('cargo', ['test', '--locked', '--manifest-path', join(desktop, 'src-tauri/Cargo.toml')]);
  run('pnpm', [
    'exec',
    'vitest',
    'run',
    '--project',
    'unit',
    'apps/mobile/src/desktop',
    'apps/mobile/src/plugins/entity-hooks.test.ts',
  ]);
} else {
  run(
    'pnpm',
    ['exec', 'expo', 'export', '-p', 'web', '--clear', '--output-dir', '../desktop/dist', '--source-maps'],
    mobile,
  );
  run('node', ['scripts/check-web-bundle.mjs', join(desktop, 'dist')], mobile);
  run('node', [join(desktop, 'scripts/check-export.mjs'), join(desktop, 'dist')]);
  if (mode === 'build') {
    run(
      'npm',
      [
        'exec',
        '--yes',
        '--package',
        '@tauri-apps/cli@2.12.4',
        '--',
        'tauri',
        'build',
        '--bundles',
        'app',
        '--config',
        overlay,
      ],
      desktop,
    );
    buildDmg({ desktop, root, env });
  }
  if (mode === 'dev') {
    // Dev still loads local assets; restart this command after changing the client.
    const child = spawn(
      'npm',
      ['exec', '--yes', '--package', '@tauri-apps/cli@2.12.4', '--', 'tauri', 'dev', '--config', overlay],
      { cwd: desktop, env, stdio: 'inherit' },
    );
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('exit', (code) => process.exit(code ?? 1));
  }
}
