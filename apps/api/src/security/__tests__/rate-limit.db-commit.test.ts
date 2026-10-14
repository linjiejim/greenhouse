import { eq, sql } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { getDb, rateLimits } from '@greenhouse/db';
import { createTestApp } from '../../testing.js';
import { PostgresRateLimitStore, RateLimiter, pruneRateLimits } from '../rate-limit.js';

const key = 'replica-limit-test';
afterAll(async () => {
  await getDb().delete(rateLimits);
});

it('counts concurrent replicas atomically and uses the database clock', async () => {
  const a = new RateLimiter(10, 60_000, new PostgresRateLimitStore(), key);
  const b = new RateLimiter(10, 60_000, new PostgresRateLimitStore(), key);
  const waits = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).hit('member')));
  expect(waits.filter((wait) => wait === 0)).toHaveLength(10);
  expect(waits.filter((wait) => wait > 0)).toHaveLength(10);
  const [row] = await getDb().select().from(rateLimits);
  expect(row!.key).toMatch(/^[a-f0-9]{64}$/);
  await getDb()
    .update(rateLimits)
    .set({ resetAt: sql`now() - interval '1 second'` })
    .where(eq(rateLimits.key, row!.key));
  expect(await b.hit('member')).toBe(0);
  await a.reset('member');
  expect(await getDb().select().from(rateLimits).where(eq(rateLimits.key, row!.key))).toEqual([]);
  await getDb()
    .insert(rateLimits)
    .values({ key: 'expired', count: 1, resetAt: sql`now() - interval '1 second'` });
  await pruneRateLimits();
  expect(await getDb().select().from(rateLimits)).toEqual([]);
});

it('shares login, OAuth and upload throttles between HTTP replicas', async () => {
  const a = createTestApp({ RATE_LIMIT_STORE: 'postgres' });
  const b = createTestApp({ RATE_LIMIT_STORE: 'postgres' });
  const person = await a.member();
  for (let i = 0; i < 10; i++) {
    const response = await (i % 2 ? a : b).call('POST', '/api/auth/login', {
      body: { email: person.email, password: 'wrong' },
    });
    expect(response.status).toBe(401);
  }
  expect((await b.call('POST', '/api/auth/login', { body: { email: person.email, password: 'wrong' } })).status).toBe(
    429,
  );
  for (let i = 0; i < 20; i++)
    expect((await (i % 2 ? a : b).call('POST', '/oauth/register', { body: {} })).status).toBe(400);
  expect((await b.call('POST', '/oauth/register', { body: {} })).status).toBe(429);
  for (let i = 0; i < 30; i++)
    expect((await (i % 2 ? a : b).call('POST', '/api/files', { token: person.token, body: {} })).status).toBe(400);
  const upload = await b.call('POST', '/api/files', { token: person.token, body: {} });
  expect(upload.status).toBe(429);
  expect(upload.body.error.code).toBe('rate_limited');
});
