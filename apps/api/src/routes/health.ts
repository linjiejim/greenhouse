/**
 * Health check route — /health
 *
 * GET /health — liveness check; reports database connectivity plus the build
 * version + commit revision (so a downloader reporting a bug can be matched to
 * the exact code — see RELEASING.md). No model or profile information is exposed.
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import { getVersionInfo } from '@greenhouse/utils/version';
import type { AppEnv } from '../app-env.js';

const health = new Hono<AppEnv>().get('/', async (c) => {
  const db = getDb() as any;
  const dbHealth = db.healthCheck ? await db.healthCheck() : { ok: true, latencyMs: 0 };
  const { version, revision } = getVersionInfo();

  const status = dbHealth.ok ? 'ok' : 'degraded';
  return c.json(
    {
      status,
      version,
      revision,
      database: {
        connected: dbHealth.ok,
        latency_ms: dbHealth.latencyMs,
      },
    },
    dbHealth.ok ? 200 : 503,
  );
});

export default health;
