/**
 * Health check route — /health
 *
 * GET /health — liveness check; reports database connectivity (no model or
 * profile information is exposed).
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import type { AppEnv } from '../app-env.js';

const health = new Hono<AppEnv>().get('/', async (c) => {
  const db = getDb() as any;
  const dbHealth = db.healthCheck ? await db.healthCheck() : { ok: true, latencyMs: 0 };

  const status = dbHealth.ok ? 'ok' : 'degraded';
  return c.json(
    {
      status,
      database: {
        connected: dbHealth.ok,
        latency_ms: dbHealth.latencyMs,
      },
    },
    dbHealth.ok ? 200 : 503,
  );
});

export default health;
