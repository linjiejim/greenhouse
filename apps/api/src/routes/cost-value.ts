/**
 * 成本与价值运营路由 — /api/admin/operations
 *
 * GET /api/admin/operations/cost-value — 获取事实型用量、Runtime 成功率与预算余额
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';

const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1_000;

function parseTimestamp(value: string | undefined, fallback: Date): Date | null {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

const costValueRoutes = new Hono<AppEnv>().get('/cost-value', async (c) => {
  // The central /api/admin/* guard is the security boundary. Reading the actor
  // here also keeps direct route mounts in tests fail-closed when no identity exists.
  getAuthUser(c);

  const now = new Date();
  const defaultSince = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const since = parseTimestamp(c.req.query('since'), defaultSince);
  const until = parseTimestamp(c.req.query('until'), now);
  if (!since || !until) return c.json({ error: 'since and until must be valid ISO timestamps' }, 400);
  if (since >= until) return c.json({ error: 'since must be before until' }, 400);
  if (until.getTime() - since.getTime() > MAX_RANGE_MS) {
    return c.json({ error: 'Reporting range cannot exceed 366 days' }, 400);
  }

  const rawLimit = c.req.query('run_limit');
  const runLimit = rawLimit === undefined ? 25 : Number(rawLimit);
  if (!Number.isInteger(runLimit) || runLimit < 1 || runLimit > 100) {
    return c.json({ error: 'run_limit must be an integer between 1 and 100' }, 400);
  }

  const report = await getDb().usage.getCostValueReport({
    since: since.toISOString(),
    until: until.toISOString(),
    run_limit: runLimit,
  });
  return c.json(report);
});

export default costValueRoutes;
