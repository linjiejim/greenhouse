import { beforeEach, afterEach, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppEnv } from './app-env.js';
import { mountClientHosting } from './hosting.js';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gh-host-'));
  for (const part of ['', 'app', 'app/_expo/static/js/web']) mkdirSync(join(dir, part), { recursive: true });
  writeFileSync(join(dir, 'app/index.html'), '<html><head></head><body>universal</body></html>');
  writeFileSync(join(dir, 'app/favicon.svg'), '<svg></svg>');
  writeFileSync(join(dir, 'app/_expo/static/js/web/entry-12345678.js'), 'universal script');
  writeFileSync(join(dir, 'app/_expo/static/js/web/[section]-0123456789abcdef.js'), 'route chunk');
  writeFileSync(join(dir, 'app/_expo/static/js/web/[section]-0123456789abcdef.js.gz'), gzipSync('route chunk'));
  writeFileSync(join(dir, 'shared.txt'), 'shared');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
it('serves the universal client and its assets without swallowing API or plugin 404s', async () => {
  const app = new Hono<AppEnv>();
  mountClientHosting(app, dir);
  for (const path of ['/', '/chat/deep/path']) {
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('universal');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
  }
  expect((await app.request('/favicon.svg')).status).toBe(200);
  expect((await app.request('/favicon.ico')).status).toBe(204);
  const script = await app.request('/_expo/static/js/web/entry-12345678.js');
  expect(await script.text()).toBe('universal script');
  expect(script.headers.get('Cache-Control')).toContain('immutable');
  expect(await (await app.request('/public/shared.txt')).text()).toBe('shared');
  for (const path of [
    '/api/nope',
    '/ext/off/ui/',
    '/oauth/nope',
    '/assets/missing.js',
    '/public/.env',
    '/public/app/index.html',
  ])
    expect((await app.request(path)).status, path).toBe(404);
});

it('serves route chunks as immutable, precompressed when the browser accepts it, and deep links as the app', async () => {
  const app = new Hono<AppEnv>();
  mountClientHosting(app, dir);
  for (const path of [
    '/_expo/static/js/web/[section]-0123456789abcdef.js',
    '/_expo/static/js/web/%5Bsection%5D-0123456789abcdef.js',
  ]) {
    const plain = await app.request(path);
    expect(plain.status, path).toBe(200);
    expect(plain.headers.get('Content-Encoding')).toBeNull();
    expect(await plain.text()).toBe('route chunk');
    const zipped = await app.request(path, { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
    expect(zipped.headers.get('Content-Encoding')).toBe('gzip');
    expect(zipped.headers.get('Content-Type')).toContain('javascript');
    expect(zipped.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(zipped.headers.get('Vary')).toContain('Accept-Encoding');
  }
  for (const path of ['/admin/users', '/p/tables/records', '/knowledge']) {
    const page = await app.request(path, { headers: { 'Accept-Encoding': 'gzip' } });
    expect(await page.text(), path).toContain('universal');
    expect(page.headers.get('Cache-Control')).toBe('no-cache');
  }
});
