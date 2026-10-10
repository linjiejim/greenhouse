/**
 * Shared by the Tables sub-routers (`/api/tables`) and the forms router
 * (`/api/forms`): dispatch through the Platform runtime as the signed-in
 * member, and map action failures to HTTP.
 */

import type { Context } from 'hono';
import type { PlatformActionResult } from '@greenhouse/platform-kernel';
import type { AppEnv } from '../../app-env.js';
import { getAuthUser } from '../../auth/middleware.js';
import { humanActor } from '../../platform/actor.js';
import type { TablesActionId } from '../../platform/manifests/tables.js';
import { tablesResource, type TablesResourceIds } from '../../platform/tables/audit.js';
import { getPlatformRuntime } from '../../platform/runtime.js';

type ActionFailure = Extract<PlatformActionResult, { ok: false }>;

function errorStatus(code: ActionFailure['code']): 400 | 403 | 404 | 409 | 500 {
  if (code === 'FORBIDDEN') return 403;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'CONFLICT') return 409;
  if (code === 'INTERNAL_ERROR') return 500;
  return 400;
}

export function actionError(c: Context<AppEnv>, result: ActionFailure) {
  return c.json(
    {
      error: result.message,
      ...(result.details ? { details: result.details } : {}),
    },
    errorStatus(result.code),
  );
}

export function numberParam(c: Context<AppEnv>, key: string): number {
  return Number(c.req.param(key));
}

export async function jsonBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => ({}));
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function dispatch(c: Context<AppEnv>, actionId: TablesActionId, payload: unknown, ids: TablesResourceIds = {}) {
  return getPlatformRuntime().dispatch({
    actor: humanActor(getAuthUser(c), c),
    appId: 'tables',
    actionId,
    payload,
    resource: tablesResource(actionId, ids),
  });
}
