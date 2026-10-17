import assert from 'node:assert/strict';
import test from 'node:test';

import { readFileSync } from 'node:fs';
import { buildTauriConfigOverlay, narrowCsp, widenCsp } from './tauri-config.mjs';

const CSP =
  "default-src 'self' greenhouse:; connect-src 'self' greenhouse: ipc: https: wss: http://localhost:* ws://localhost:*; img-src 'self' data: https:; media-src 'self' blob:";
const directive = (csp, name) => csp.split(';').find((d) => d.trim().startsWith(`${name} `));

test('no deployment variables → no overlay, so a plain build stays a plain build', () => {
  assert.equal(buildTauriConfigOverlay({}, CSP), null);
  assert.equal(buildTauriConfigOverlay({ GREENHOUSE_DESKTOP_API_BASE: '  ' }, CSP), null);
});

test('a deployment bakes in identity, updater key and its server origins', () => {
  const overlay = buildTauriConfigOverlay(
    {
      GREENHOUSE_DESKTOP_IDENTIFIER: 'cn.example.greenhouse',
      GREENHOUSE_DESKTOP_UPDATER_PUBKEY: 'dW50cnVzdGVk',
      GREENHOUSE_DESKTOP_API_BASE: 'https://greenhouse.example.com:18888',
      GREENHOUSE_DESKTOP_CSP_EXTRA_ORIGINS: 'https://*.myqcloud.com, https://ui-avatars.com',
    },
    CSP,
  );
  assert.equal(overlay.identifier, 'cn.example.greenhouse');
  assert.deepEqual(overlay.plugins, { updater: { pubkey: 'dW50cnVzdGVk' } });
  const csp = overlay.app.security.csp;
  // connect-src also gets the WebSocket form of the server; img/media get the plain origins.
  assert.match(csp, /connect-src [^;]*https:\/\/greenhouse\.example\.com:18888 wss:\/\/greenhouse\.example\.com:18888/);
  assert.match(
    csp,
    /img-src [^;]*https:\/\/greenhouse\.example\.com:18888 https:\/\/\*\.myqcloud\.com https:\/\/ui-avatars\.com/,
  );
  assert.match(csp, /media-src [^;]*https:\/\/\*\.myqcloud\.com/);
  // A fixed server is the only https host connect-src reaches; images stay open.
  assert.doesNotMatch(directive(csp, 'connect-src'), / https: | wss: /);
  assert.match(directive(csp, 'connect-src'), /http:\/\/localhost:\*/);
  assert.match(directive(csp, 'img-src'), / https:/);
  // Untouched directives are byte-identical.
  assert.match(csp, /^default-src 'self' greenhouse:;/);
});

test('an unlocked build keeps the committed policy, which reaches any https server', () => {
  const overlay = buildTauriConfigOverlay({ GREENHOUSE_DESKTOP_IDENTIFIER: 'com.example.greenhouse' }, CSP);
  assert.equal(overlay.app, undefined);
  const committed = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url))).app.security.csp;
  for (const source of ['https:', 'wss:', 'http://localhost:*', 'ws://localhost:*'])
    assert.ok(directive(committed, 'connect-src').split(/\s+/).includes(source), source);
});

test('a fixed local server still narrows connect-src', () => {
  const overlay = buildTauriConfigOverlay({ GREENHOUSE_DESKTOP_API_BASE: 'http://localhost:3000' }, CSP);
  assert.equal(overlay.app.security.csp, narrowCsp(CSP));
  assert.doesNotMatch(directive(narrowCsp(CSP), 'connect-src'), / https: | wss: /);
});

test('an update source on another host is named in the CSP too', () => {
  const overlay = buildTauriConfigOverlay(
    { GREENHOUSE_DESKTOP_UPDATE_BASE: 'https://greenhouse.example.com/updates/desktop' },
    CSP,
  );
  assert.match(
    overlay.app.security.csp,
    /connect-src [^;]*https:\/\/greenhouse\.example\.com wss:\/\/greenhouse\.example\.com/,
  );
  assert.equal(overlay.identifier, undefined);
});

test('rejects a server that is not a bare origin', () => {
  assert.throws(
    () => buildTauriConfigOverlay({ GREENHOUSE_DESKTOP_API_BASE: 'https://example.com/base' }, CSP),
    /bare http\(s\) origin/,
  );
  assert.throws(
    () => buildTauriConfigOverlay({ GREENHOUSE_DESKTOP_API_BASE: 'example.com' }, CSP),
    /bare http\(s\) origin/,
  );
  assert.throws(
    () => buildTauriConfigOverlay({ GREENHOUSE_DESKTOP_CSP_EXTRA_ORIGINS: 'https://cdn.example.com/path' }, CSP),
    /must be origins/,
  );
});

test('widenCsp never duplicates an origin a directive already lists', () => {
  const once = widenCsp(CSP, ['http://localhost:3100']);
  const connect = once.split(';').find((d) => d.trim().startsWith('connect-src'));
  assert.equal(connect.split('http://localhost:3100').length - 1, 1);
  assert.equal(connect.split('ws://localhost:3100').length - 1, 1);
});
