/**
 * Browser client-action result endpoint — /api/client-actions.
 *
 * POST /tool-result closes the request/response loop started by a client action
 * advertised on `/api/chat`. Authentication is applied by the static route
 * mount in `index.ts`.
 */

import { Hono } from 'hono';
import { logger } from '@greenhouse/utils/logger';
import { getAuthUser } from '../auth/middleware.js';
import { resolveClientActionResult } from '../tools/client-action-pending.js';
import type { AppEnv } from '../app-env.js';

const clientActionRoutes = new Hono<AppEnv>().post('/tool-result', async (c) => {
  const user = getAuthUser(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    session_id?: string;
    toolCallId?: string;
    output?: unknown;
    error?: string;
  };

  const { session_id: sessionId, toolCallId, output, error } = body;
  if (!sessionId || !toolCallId) {
    return c.json({ error: 'session_id and toolCallId are required' }, 400);
  }

  const resolved = resolveClientActionResult(user.id, sessionId, toolCallId, output, error);
  if (resolved) {
    logger.info(`[ClientAction] Result received: ${toolCallId} (session: ${sessionId})`);
  } else {
    logger.warn(`[ClientAction] No pending request for result: ${toolCallId} (session: ${sessionId})`);
  }

  return c.json({ ok: true, resolved });
});

export default clientActionRoutes;
