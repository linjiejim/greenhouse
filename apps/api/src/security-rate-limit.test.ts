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
