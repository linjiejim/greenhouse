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
it("adds the plugin's declared media origins to its own CSP only", async () => {
  writeFileSync(join(dir, 'index.html'), 'ui');
  const other = mkdtempSync(join(tmpdir(), 'gh-plugin-ui-'));
  writeFileSync(join(other, 'index.html'), 'other');
  fixture.extensions.push({ id: 'fixture', ui: { dir }, uiMedia: ['https://cdn.example.com'] } as never, {
    id: 'other',
    ui: { dir: other },
  });
  try {
    const own = (await host().request('/ext/fixture/ui/')).headers.get('Content-Security-Policy') ?? '';
    expect(own).toMatch(/img-src 'self' data: blob:[^;]* https:\/\/cdn\.example\.com/);
    expect(own).toMatch(/media-src 'self' blob:[^;]* https:\/\/cdn\.example\.com/);
    const theirs = (await host().request('/ext/other/ui/')).headers.get('Content-Security-Policy') ?? '';
    expect(theirs).not.toContain('cdn.example.com');
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});
it('caches bundler-fingerprinted assets for a year and revalidates the rest with a 304', async () => {
  mkdirSync(join(dir, 'dist/assets'), { recursive: true });
  writeFileSync(join(dir, 'dist/index.html'), 'built');
  writeFileSync(join(dir, 'dist/assets/index-D63n5Bgy.js'), 'script');
  writeFileSync(join(dir, 'dist/app.js'), 'plain');
  writeFileSync(join(dir, 'dist/tokens.generated.js'), 'tokens');
  fixture.extensions.push({ id: 'fixture', ui: { dir } });
  const vite = await host().request('/ext/fixture/ui/assets/index-D63n5Bgy.js');
  expect(vite.headers.get('Cache-Control')).toContain('immutable');
  for (const path of ['/ext/fixture/ui/', '/ext/fixture/ui/app.js', '/ext/fixture/ui/tokens.generated.js']) {
    const first = await host().request(path);
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('no-cache');
    const tag = first.headers.get('ETag');
    expect(tag).toMatch(/^W\/"/);
    const again = await host().request(path, { headers: { 'If-None-Match': tag! } });
    expect(again.status).toBe(304);
    expect(again.headers.get('ETag')).toBe(tag);
  }
  // a changed file answers in full again
  const before = (await host().request('/ext/fixture/ui/app.js')).headers.get('ETag')!;
  writeFileSync(join(dir, 'dist/app.js'), 'plain, but longer');
  expect((await host().request('/ext/fixture/ui/app.js', { headers: { 'If-None-Match': before } })).status).toBe(200);
});
