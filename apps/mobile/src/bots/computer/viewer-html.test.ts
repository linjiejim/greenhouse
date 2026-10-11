/**
 * The viewer page (./viewer-html.ts) and its bundle (./novnc.generated.ts):
 * the bridge's message shapes, the commands the app injects, and that the
 * bundled noVNC is the web's own version (regenerate with
 * `node apps/mobile/scripts/build-novnc.mjs` after upgrading it in apps/web).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOVNC_SOURCE, NOVNC_VERSION } from './novnc.generated';
import { HELPER_KEYS, readViewerMessage, viewerCommand, viewerHtml } from './viewer-html';

const ROOT = resolve(__dirname, '../../../../..');

describe('the noVNC bundle', () => {
  it('is the version apps/web installs', () => {
    const entry = createRequire(resolve(ROOT, 'apps/web/package.json')).resolve('@novnc/novnc');
    const { version } = JSON.parse(readFileSync(resolve(entry, '../../package.json'), 'utf8')) as { version: string };
    expect(NOVNC_VERSION, 'apps/web upgraded noVNC — run node apps/mobile/scripts/build-novnc.mjs').toBe(version);
    expect(NOVNC_SOURCE.startsWith(`/* noVNC ${version} `)).toBe(true);
    expect(NOVNC_SOURCE).toContain('window.RFB=');
  });
});

describe('viewerHtml', () => {
  const html = viewerHtml('#F2F2F7');

  it('inlines the bundle as a module and the viewer before it', () => {
    expect(html.indexOf('window.gh =')).toBeGreaterThan(0);
    expect(html.indexOf('<script type="module">')).toBeGreaterThan(html.indexOf('window.gh ='));
    // nothing inside a script may end it early
    const scripts = html.split('<script').length - 1;
    expect(html.split('</script>').length - 1).toBe(scripts);
    expect(html).toContain('background:#F2F2F7');
    expect(html).not.toContain('__KEYS__');
  });

  it('loads nothing over the network (the only connection is the screen socket it is handed)', () => {
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
  });

  it('knows every helper key the control bar offers', () => {
    for (const [name, [keysym, code]] of Object.entries(HELPER_KEYS)) {
      expect(html).toContain(`"${name}":[${keysym},"${code}"]`);
    }
  });
});

describe('the bridge', () => {
  it('reads the page’s messages and drops anything else', () => {
    expect(readViewerMessage('{"t":"ready"}')).toEqual({ t: 'ready' });
    expect(readViewerMessage('{"t":"connected"}')).toEqual({ t: 'connected' });
    expect(readViewerMessage('{"t":"disconnected","clean":true}')).toEqual({ t: 'disconnected', clean: true });
    expect(readViewerMessage('{"t":"disconnected"}')).toEqual({ t: 'disconnected', clean: false });
    expect(readViewerMessage('{"t":"tap-view-only"}')).toEqual({ t: 'tap-view-only' });
    expect(readViewerMessage('{"t":"zoom","z":2.5}')).toEqual({ t: 'zoom', z: 2.5 });
    expect(readViewerMessage('{"t":"zoom","z":"big"}')).toBeNull();
    expect(readViewerMessage('{"t":"eval","code":"x"}')).toBeNull();
    expect(readViewerMessage('not json')).toBeNull();
  });

  it('injects commands as JSON arguments (a URL can never break out of the call)', () => {
    expect(viewerCommand('connect', 'wss://h/api/ws/computer?token=a"b')).toBe(
      'window.gh&&window.gh.connect("wss://h/api/ws/computer?token=a\\"b");true;',
    );
    expect(viewerCommand('viewOnly', false)).toBe('window.gh&&window.gh.viewOnly(false);true;');
    expect(viewerCommand('key', 'enter')).toBe('window.gh&&window.gh.key("enter");true;');
    expect(viewerCommand('disconnect')).toBe('window.gh&&window.gh.disconnect();true;');
  });
});
