import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { rateLimitMiddleware } from './security.js';

describe('anonymous OAuth endpoint rate limits', () => {
  it.each([
    ['/oauth/register', 10],
    ['/oauth/token', 60],
    ['/oauth/revoke', 60],
  ] as const)('bounds %s per source', async (path, max) => {
    const app = new Hono().use('*', rateLimitMiddleware).post(path, (c) => c.json({ ok: true }));
    const sourceIp = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;

    for (let i = 0; i < max; i++) {
      const response = await app.request(path, {
        method: 'POST',
        headers: { 'x-forwarded-for': sourceIp },
      });
      expect(response.status).toBe(200);
    }

    const blocked = await app.request(path, {
      method: 'POST',
      headers: { 'x-forwarded-for': sourceIp },
    });
    expect(blocked.status).toBe(429);
  });
});

describe('password-link IP rate limit', () => {
  it('uses the dedicated password-link budget instead of the generic login budget', async () => {
    const path = '/api/auth/password-link/inspect';
    const app = new Hono().use('*', rateLimitMiddleware).post(path, (c) => c.json({ ok: true }));
    const sourceIp = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;

    for (let i = 0; i < 20; i++) {
      expect(
        (
          await app.request(path, {
            method: 'POST',
            headers: { 'x-forwarded-for': sourceIp },
          })
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await app.request(path, {
          method: 'POST',
          headers: { 'x-forwarded-for': sourceIp },
        })
      ).status,
    ).toBe(429);
  });
});

describe('session reads under /api/auth', () => {
  const hit = (app: Hono, path: string, sourceIp: string, method = 'GET') =>
    app.request(path, { method, headers: { 'x-forwarded-for': sourceIp } }).then((r) => r.status);

  it('never throttles /me and its siblings with the login budget (every page load asks)', async () => {
    const app = new Hono()
      .use('*', rateLimitMiddleware)
      .get('/api/auth/me', (c) => c.json({ ok: true }))
      .get('/api/auth/me/features', (c) => c.json({ ok: true }));
    const sourceIp = `192.0.2.${Math.floor(Math.random() * 200) + 1}`;
    for (let i = 0; i < 40; i++) {
      expect(await hit(app, '/api/auth/me', sourceIp)).toBe(200);
      expect(await hit(app, '/api/auth/me/features', sourceIp)).toBe(200);
    }
  });

  it('keeps the login budget at ten attempts per source, and gives token refresh its own', async () => {
    const app = new Hono()
      .use('*', rateLimitMiddleware)
      .post('/api/auth/login', (c) => c.json({ ok: true }))
      .post('/api/auth/refresh', (c) => c.json({ ok: true }));
    const sourceIp = `192.0.2.${Math.floor(Math.random() * 200) + 1}`;
    for (let i = 0; i < 10; i++) expect(await hit(app, '/api/auth/login', sourceIp, 'POST')).toBe(200);
    expect(await hit(app, '/api/auth/login', sourceIp, 'POST')).toBe(429);
    for (let i = 0; i < 60; i++) expect(await hit(app, '/api/auth/refresh', sourceIp, 'POST')).toBe(200);
    expect(await hit(app, '/api/auth/refresh', sourceIp, 'POST')).toBe(429);
  });
});
