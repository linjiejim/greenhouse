/**
 * Health check route — /health
 *
 * GET /health — health check: database status + runtime kill-switch posture (no model or profile details)
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import type { AppEnv } from '../app-env.js';
import { resolveTrustedExecutionSwitches, trustedExecutionHealthView } from '../trusted-execution/kill-switches.js';

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
      trusted_execution: trustedExecutionHealthView(resolveTrustedExecutionSwitches()),
    },
    dbHealth.ok ? 200 : 503,
  );
});

export default health;
