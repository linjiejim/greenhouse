import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareDesktopCommand, sharedCargoTargetDir, withConfigArg } from './with-shared-target.mjs';

test('keeps CI build identity and updater artifacts untouched', () => {
  const result = prepareDesktopCommand(
    'tauri',
    ['build'],
    {
      CI: 'true',
      APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example',
      TAURI_SIGNING_PRIVATE_KEY: 'secret',
    },
    'darwin',
  );

  assert.deepEqual(result.args, ['build']);
  assert.equal(result.env.APPLE_SIGNING_IDENTITY, 'Developer ID Application: Example');
  assert.equal(result.config, null);
});

test('drops the Apple variables a CI runner materialised as empty strings', () => {
  const result = prepareDesktopCommand(
    'tauri',
    ['build'],
    {
      CI: 'true',
      APPLE_CERTIFICATE: '',
      APPLE_CERTIFICATE_PASSWORD: '',
      APPLE_API_ISSUER: '',
      APPLE_API_KEY: '',
      APPLE_SIGNING_IDENTITY: '-',
      TAURI_SIGNING_PRIVATE_KEY: 'secret',
    },
    'darwin',
  );

  assert.equal('APPLE_CERTIFICATE' in result.env, false);
  assert.equal('APPLE_API_ISSUER' in result.env, false);
  assert.equal(result.env.APPLE_SIGNING_IDENTITY, '-');
  assert.equal(result.env.TAURI_SIGNING_PRIVATE_KEY, 'secret');
});

test('fully ad-hoc signs a local macOS bundle and disables unsigned updater artifacts', () => {
  const result = prepareDesktopCommand('tauri', ['build', '--bundles', 'app'], {}, 'darwin');

  assert.equal(result.env.APPLE_SIGNING_IDENTITY, '-');
  assert.deepEqual(result.args, ['build', '--bundles', 'app']);
  assert.deepEqual(result.config, { bundle: { createUpdaterArtifacts: false } });
});

test('respects explicit local signing choices', () => {
  const result = prepareDesktopCommand(
    'tauri',
    ['build', '--no-sign', '--', '--features', 'diagnostics'],
    { APPLE_SIGNING_IDENTITY: 'Local Development' },
    'darwin',
  );

  assert.equal(result.env.APPLE_SIGNING_IDENTITY, 'Local Development');
  assert.deepEqual(result.args, ['build', '--no-sign', '--', '--features', 'diagnostics']);
  assert.deepEqual(result.config, { bundle: { createUpdaterArtifacts: false } });
});

test('does not mutate non-build commands', () => {
  const env = { CARGO_TARGET_DIR: '/tmp/desktop-target' };
  const result = prepareDesktopCommand('cargo', ['test'], env, 'darwin');

  assert.deepEqual(result.args, ['test']);
  assert.deepEqual(result.env, env);
  assert.equal(result.config, null);
  assert.equal(sharedCargoTargetDir(env), '/tmp/desktop-target');
});

test('merges the deployment overlay into the config for dev and build, in CI too', () => {
  const overlay = { identifier: 'com.example.greenhouse', bundle: { targets: ['app'] } };
  const dev = prepareDesktopCommand('tauri', ['dev'], { CI: 'true' }, 'darwin', overlay);
  assert.deepEqual(dev.config, overlay);

  const ciBuild = prepareDesktopCommand('tauri', ['build'], { CI: 'true' }, 'windows', overlay);
  assert.deepEqual(ciBuild.config, overlay);

  // A local build without a minisign key adds its own bundle override without
  // dropping the overlay's other bundle keys.
  const localBuild = prepareDesktopCommand('tauri', ['build'], {}, 'darwin', overlay);
  assert.deepEqual(localBuild.config, {
    identifier: 'com.example.greenhouse',
    bundle: { targets: ['app'], createUpdaterArtifacts: false },
  });
  // The caller's overlay object is never mutated.
  assert.deepEqual(overlay, { identifier: 'com.example.greenhouse', bundle: { targets: ['app'] } });

  // Other tauri subcommands and plain cargo never receive it.
  assert.equal(prepareDesktopCommand('tauri', ['info'], {}, 'darwin', overlay).config, null);
  assert.equal(prepareDesktopCommand('cargo', ['test'], {}, 'darwin', overlay).config, null);
});

test('the config path goes before runner arguments, never inline JSON', () => {
  assert.deepEqual(withConfigArg(['build'], '/tmp/x/tauri.overlay.json'), [
    'build',
    '--config',
    '/tmp/x/tauri.overlay.json',
  ]);
  assert.deepEqual(withConfigArg(['build', '--', '--features', 'diagnostics'], '/tmp/x.json'), [
    'build',
    '--config',
    '/tmp/x.json',
    '--',
    '--features',
    'diagnostics',
  ]);
});
