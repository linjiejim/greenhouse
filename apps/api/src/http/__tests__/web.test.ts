import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { webRoutes } from '../web.js';

function site() {
  const parent = mkdtempSync(join(tmpdir(), 'gh-web-'));
  const dir = join(parent, 'public');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Greenhouse</title>');
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(join(dir, 'favicon.svg'), '<svg/>');
  writeFileSync(join(dir, 'notes.md'), '# private');
  writeFileSync(join(parent, 'secret.txt'), 'outside');
  const app = new Hono();
  app.get('/api/me', (c) => c.json({ ok: true }));
  app.route('/', webRoutes(dir));
  return app;
}

describe('the web app', () => {
  it('serves index.html uncached, with a content security policy', async () => {
    const response = await site().request('/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await response.text()).toContain('<title>Greenhouse</title>');
  });

  it('caches hashed assets for good and root files briefly', async () => {
    const app = site();
    const asset = await app.request('/assets/index-abc123.js');
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await asset.text()).toBe('console.log(1)');
    expect((await app.request('/favicon.svg')).headers.get('cache-control')).toBe('public, max-age=3600');
    const head = await app.request('/favicon.svg', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('6');
  });

  it('leaves /api alone and serves nothing outside the folder or of an unknown type', async () => {
    const app = site();
    expect(await (await app.request('/api/me')).json()).toEqual({ ok: true });
    expect((await app.request('/notes.md')).status).toBe(404);
    expect((await app.request('/../secret.txt')).status).toBe(404);
    expect((await app.request('/%2e%2e/secret.txt')).status).toBe(404);
    expect((await app.request('/missing.js')).status).toBe(404);
    expect((await app.request('/', { method: 'POST' })).status).toBe(404);
  });
});
