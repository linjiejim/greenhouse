import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTauriConfigOverlay, widenCsp } from './tauri-config.mjs';

const CSP =
  "default-src 'self' greenhouse:; connect-src 'self' greenhouse: ipc: http://localhost:3100 ws://localhost:3100; img-src 'self' data: https:; media-src 'self' blob:";

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
  // Untouched directives are byte-identical.
  assert.match(csp, /^default-src 'self' greenhouse:;/);
});

test('an update source on another host is allowed through the CSP too', () => {
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
