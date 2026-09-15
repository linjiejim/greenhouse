import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareDesktopCommand, sharedCargoTargetDir } from './with-shared-target.mjs';

test('keeps CI build identity and updater artifacts untouched', () => {
  const result = prepareDesktopCommand(
    'tauri',
    ['build'],
    {
      CI: 'true',
      APPLE_SIGNING_IDENTITY: 'Developer ID Application: LetPot',
      TAURI_SIGNING_PRIVATE_KEY: 'secret',
    },
    'darwin',
  );

  assert.deepEqual(result.args, ['build']);
  assert.equal(result.env.APPLE_SIGNING_IDENTITY, 'Developer ID Application: LetPot');
});

test('fully ad-hoc signs a local macOS bundle and disables unsigned updater artifacts', () => {
  const result = prepareDesktopCommand('tauri', ['build', '--bundles', 'app'], {}, 'darwin');

  assert.equal(result.env.APPLE_SIGNING_IDENTITY, '-');
  assert.deepEqual(result.args, [
    'build',
    '--bundles',
    'app',
    '--config',
    '{"bundle":{"createUpdaterArtifacts":false}}',
  ]);
});

test('respects explicit local signing choices and runner arguments', () => {
  const result = prepareDesktopCommand(
    'tauri',
    ['build', '--no-sign', '--', '--features', 'diagnostics'],
    { APPLE_SIGNING_IDENTITY: 'Local Development' },
    'darwin',
  );

  assert.equal(result.env.APPLE_SIGNING_IDENTITY, 'Local Development');
  assert.deepEqual(result.args, [
    'build',
    '--no-sign',
    '--config',
    '{"bundle":{"createUpdaterArtifacts":false}}',
    '--',
    '--features',
    'diagnostics',
  ]);
});

test('does not mutate non-build commands', () => {
  const env = { CARGO_TARGET_DIR: '/tmp/desktop-target' };
  const result = prepareDesktopCommand('cargo', ['test'], env, 'darwin');

  assert.deepEqual(result.args, ['test']);
  assert.deepEqual(result.env, env);
  assert.equal(sharedCargoTargetDir(env), '/tmp/desktop-target');
});

test('appends the deployment overlay to dev and build, before runner arguments', () => {
  const overlay = { identifier: 'com.example.greenhouse' };
  const dev = prepareDesktopCommand('tauri', ['dev'], { CI: 'true' }, 'darwin', overlay);
  assert.deepEqual(dev.args, ['dev', '--config', '{"identifier":"com.example.greenhouse"}']);

  const build = prepareDesktopCommand(
    'tauri',
    ['build', '--', '--features', 'diagnostics'],
    { CI: 'true', TAURI_SIGNING_PRIVATE_KEY: 'secret' },
    'darwin',
    overlay,
  );
  assert.deepEqual(build.args, [
    'build',
    '--config',
    '{"identifier":"com.example.greenhouse"}',
    '--',
    '--features',
    'diagnostics',
  ]);

  // Other tauri subcommands and plain cargo never receive it.
  assert.deepEqual(prepareDesktopCommand('tauri', ['info'], {}, 'darwin', overlay).args, ['info']);
  assert.deepEqual(prepareDesktopCommand('cargo', ['test'], {}, 'darwin', overlay).args, ['test']);
});
