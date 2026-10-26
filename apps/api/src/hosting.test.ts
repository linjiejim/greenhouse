import { beforeEach, afterEach, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppEnv } from './app-env.js';
import { mountClientHosting } from './hosting.js';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gh-host-'));
  for (const part of ['', 'app', 'assets', 'app/_expo/static/js/web']) mkdirSync(join(dir, part), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<html><head></head><body>classic</body></html>');
  writeFileSync(join(dir, 'app/index.html'), '<html><head></head><body>universal</body></html>');
  writeFileSync(join(dir, 'assets/classic-12345678.js'), 'classic script');
  writeFileSync(join(dir, 'favicon.svg'), '<svg></svg>');
  writeFileSync(join(dir, 'app/_expo/static/js/web/entry-12345678.js'), 'universal script');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
it.each(['classic', 'universal'] as const)(
  'serves both SPAs and correct assets in %s mode without swallowing API or plugin 404s',
  async (mode) => {
    const app = new Hono<AppEnv>();
    mountClientHosting(app, dir, mode);
    for (const path of ['/', '/chat/deep/path']) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(mode);
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
    }
    for (const path of ['/classic/', '/classic/deep/path']) {
      const response = await app.request(path);
      expect(await response.text()).toContain('<base href="/classic/">');
    }
    expect((await app.request('/classic')).headers.get('location')).toBe('/classic/');
    expect((await app.request('/favicon.svg')).status).toBe(200);
    expect((await app.request('/favicon.ico')).status).toBe(204);
    const classic = await app.request('/classic/assets/classic-12345678.js');
    expect(await classic.text()).toBe('classic script');
    expect(classic.headers.get('Cache-Control')).toContain('immutable');
    if (mode === 'universal')
      expect(await (await app.request('/_expo/static/js/web/entry-12345678.js')).text()).toBe('universal script');
    for (const path of [
      '/api/nope',
      '/ext/off/ui/',
      '/oauth/nope',
      '/assets/missing.js',
      '/classic/missing.css',
      '/public/.env',
      '/public/app/index.html',
    ])
      expect((await app.request(path)).status, path).toBe(404);
  },
);
