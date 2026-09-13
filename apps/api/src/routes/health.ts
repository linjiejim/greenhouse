/**
 * Health check route — /health
 *
 * GET /health — health check: database status + runtime/mission readiness (no model or profile details)
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import type { AppEnv } from '../app-env.js';
import { getMissionRuntimeStatus, type MissionRuntimeStatus } from '../cloud-agent/index.js';
import { resolveTrustedExecutionSwitches, trustedExecutionHealthView } from '../trusted-execution/kill-switches.js';

/** Public health posture: never expose host paths, images or preflight errors. */
export function missionHealthView(status: MissionRuntimeStatus) {
  if (status.state === 'unavailable') return { state: status.state, containment: status.containment };
  if (status.state !== 'ready') return { state: status.state };
  return {
    state: status.state,
    isolation: {
      runtime: status.runtime,
      root_filesystem: status.rootFilesystem,
      workspace_quota: status.workspaceQuota,
    },
  };
}

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
      mission: missionHealthView(getMissionRuntimeStatus()),
      trusted_execution: trustedExecutionHealthView(resolveTrustedExecutionSwitches()),
    },
    dbHealth.ok ? 200 : 503,
  );
});

export default health;
