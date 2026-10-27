import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppEnv } from '../../app-env.js';
import { securityHeadersMiddleware } from '../../security/security.js';
import { mountExtensionUis } from '../boot.js';
const fixture = vi.hoisted(() => ({ extensions: [] as Array<{ id: string; ui: { dir: string } }> }));
vi.mock('../index.js', () => ({ EXTENSIONS: fixture.extensions, COMPILED_EXTENSIONS: [], fromExtensions: () => [] }));
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gh-plugin-ui-'));
  fixture.extensions.splice(0);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function host() {
  const app = new Hono<AppEnv>().use('*', securityHeadersMiddleware);
  mountExtensionUis(app);
  return app;
}
it('serves an unbuilt UI with restricted framing and revalidation, and 404s when disabled', async () => {
  writeFileSync(join(dir, 'index.html'), '<h1>Source UI</h1>');
  fixture.extensions.push({ id: 'fixture', ui: { dir } });
  const response = await host().request('/ext/fixture/ui/');
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('Source UI');
  expect(response.headers.get('Cache-Control')).toBe('no-cache');
  expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'self' tauri://localhost");
  expect((await host().request('/ext/fixture/ui/missing.js')).status).toBe(404);
  fixture.extensions.splice(0);
  expect((await host().request('/ext/fixture/ui/')).status).toBe(404);
});
it('prefers dist and caches only fingerprinted assets immutably', async () => {
  writeFileSync(join(dir, 'index.html'), 'source');
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist/index.html'), 'built');
  writeFileSync(join(dir, 'dist/app-12345678.js'), 'script');
  fixture.extensions.push({ id: 'fixture', ui: { dir } });
  expect(await (await host().request('/ext/fixture/ui/')).text()).toBe('built');
  expect((await host().request('/ext/fixture/ui/app-12345678.js')).headers.get('Cache-Control')).toContain('immutable');
});
