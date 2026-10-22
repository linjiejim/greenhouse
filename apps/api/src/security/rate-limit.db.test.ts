/**
 * Rate limits against the real counter table (`rate_limit_buckets`).
 *
 * Every key is unique per run: the table is shared with anything else that has
 * committed rows. Cross-connection concurrency is pinned separately in
 * tests/db/security-state.db-commit.test.ts.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { checkRateLimit, rateLimitMiddleware } from './security.js';

let db: DatabaseProvider;
const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
});

afterEach(async () => {
  await db.close();
  _resetProvider();
});

describe('checkRateLimit', () => {
  it('counts down remaining and blocks past the limit, per key', async () => {
    const now = Date.now();
    const first = await checkRateLimit(`t:a:${run}`, 60_000, 3, now);
    expect(first).toMatchObject({ allowed: true, remaining: 2 });
    await checkRateLimit(`t:a:${run}`, 60_000, 3, now);
    expect(await checkRateLimit(`t:a:${run}`, 60_000, 3, now)).toMatchObject({ allowed: true, remaining: 0 });
    expect(await checkRateLimit(`t:a:${run}`, 60_000, 3, now)).toMatchObject({ allowed: false, remaining: 0 });
    // Another key has its own budget.
    expect(await checkRateLimit(`t:b:${run}`, 60_000, 3, now)).toMatchObject({ allowed: true, remaining: 2 });
  });

  it('uses fixed windows aligned to the epoch and starts over in the next one', async () => {
    const windowStart = Math.floor(Date.now() / 60_000) * 60_000;
    for (let i = 0; i < 2; i++) await checkRateLimit(`t:w:${run}`, 60_000, 2, windowStart + 10);
    const blocked = await checkRateLimit(`t:w:${run}`, 60_000, 2, windowStart + 59_999);
    expect(blocked).toEqual({ allowed: false, remaining: 0, resetAt: windowStart + 60_000 });
    const next = await checkRateLimit(`t:w:${run}`, 60_000, 2, windowStart + 60_000);
    expect(next).toEqual({ allowed: true, remaining: 1, resetAt: windowStart + 120_000 });
  });

  it('adds up concurrent hits on one bucket exactly', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => checkRateLimit(`t:c:${run}`, 60_000, 10)));
    expect(results.filter((result) => result.allowed)).toHaveLength(10);
    expect(new Set(results.map((result) => result.remaining)).size).toBeGreaterThan(1);
  });

  it('sweeps only buckets whose window has ended', async () => {
    const past = Date.now() - 10 * 60_000;
    await checkRateLimit(`t:s-old:${run}`, 60_000, 5, past);
    await checkRateLimit(`t:s-new:${run}`, 60_000, 5);
    expect(await db.rateLimits.sweepExpired()).toBeGreaterThanOrEqual(1);
    // The old window is gone (a hit in it starts from one again); the live one is kept.
    expect((await checkRateLimit(`t:s-old:${run}`, 60_000, 5, past)).remaining).toBe(4);
    expect((await checkRateLimit(`t:s-new:${run}`, 60_000, 5)).remaining).toBe(3);
  });
});

describe('rate limit middleware', () => {
  it('keeps the response headers: limit, remaining and the window end in epoch seconds', async () => {
    const app = new Hono().use('*', rateLimitMiddleware).post('/oauth/token', (c) => c.json({ ok: true }));
    const response = await app.request('/oauth/token', {
      method: 'POST',
      headers: {
        'x-forwarded-for': `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`,
      },
    });
    expect(response.headers.get('X-RateLimit-Limit')).toBe('60');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('59');
    const reset = Number(response.headers.get('X-RateLimit-Reset'));
    expect(reset % 60).toBe(0);
    expect(reset * 1000).toBeGreaterThan(Date.now());
  });
});

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
  const hit = async (app: Hono, path: string, sourceIp: string, method = 'GET') =>
    (await app.request(path, { method, headers: { 'x-forwarded-for': sourceIp } })).status;

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
