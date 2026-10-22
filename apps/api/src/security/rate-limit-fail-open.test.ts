/**
 * Rate limiting fails open: a counter-table outage lets requests through and
 * says so in the log (throttled), instead of answering 429 to everyone.
 */

import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

const hit = vi.hoisted(() => vi.fn());
vi.mock('@greenhouse/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@greenhouse/db')>();
  return { ...actual, getDb: () => ({ rateLimits: { hit } }) };
});
const warn = vi.hoisted(() => vi.fn());
vi.mock('@greenhouse/utils/logger', () => ({ logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { _resetRateLimitWarnings, checkRateLimit, rateLimitMiddleware } from './security.js';

afterEach(() => {
  hit.mockReset();
  warn.mockReset();
  _resetRateLimitWarnings();
});

describe('rate limit fail-open', () => {
  it('allows the request when the counter cannot be reached', async () => {
    hit.mockRejectedValue(new Error('connection terminated'));
    const now = 1_800_000_000_000;
    expect(await checkRateLimit('k', 60_000, 10, now)).toEqual({
      allowed: true,
      remaining: 9,
      resetAt: Math.floor(now / 60_000) * 60_000 + 60_000,
    });
  });

  it('logs one warning per minute, counting what it let through', async () => {
    hit.mockRejectedValue(new Error('connection terminated'));
    const now = 1_800_000_000_000;
    for (let i = 0; i < 5; i++) await checkRateLimit('k', 60_000, 10, now + i);
    expect(warn).toHaveBeenCalledTimes(1);
    await checkRateLimit('k', 60_000, 10, now + 60_000);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]![1]).toMatchObject({ allowedSinceLastWarning: 5 });
  });

  it('keeps the middleware serving (no 429, no 500) through the outage', async () => {
    hit.mockRejectedValue(new Error('connection terminated'));
    const app = new Hono().use('*', rateLimitMiddleware).post('/api/auth/login', (c) => c.json({ ok: true }));
    for (let i = 0; i < 15; i++) {
      const response = await app.request('/api/auth/login', { method: 'POST' });
      expect(response.status).toBe(200);
    }
  });

  it('still blocks when the counter answers', async () => {
    hit.mockResolvedValue(11);
    expect((await checkRateLimit('k', 60_000, 10)).allowed).toBe(false);
  });
});
