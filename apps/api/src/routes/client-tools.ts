/**
 * Client-tool routes — /api/client-tools
 *
 * POST /api/client-tools/result — Receive client-action (browser UI tool)
 * execution results from the web client, resuming the paused agent step.
 */

import { Hono } from 'hono';
import { requireInternal } from '../auth/middleware.js';
import { logger } from '@greenhouse/utils/logger';
import { resolveLocalToolResult } from '../tools/local/pending.js';
import type { AppEnv } from '../app-env.js';

// The pending-result registry lives in tools/local/pending.ts so the client-tool
// bridge and this route share a single source of truth. `waitForLocalToolResult`
// is re-exported there for the bridge; this route only resolves results.

// ─── Route Factory ───────────────────────────────────────

export function createClientToolsRoute() {
  return (
    new Hono<AppEnv>()
      // All client-tool endpoints require an authenticated internal user
      .use('/*', requireInternal())
      /**
       * POST /api/client-tools/result
       * Body: { session_id, toolCallId, output, error? }
       *
       * Receives execution results from the web client for client actions.
       */
      .post('/result', async (c) => {
        const body = (await c.req.json()) as {
          session_id: string;
          toolCallId: string;
          output: unknown;
          error?: string;
        };

        const { session_id, toolCallId, output, error } = body;

        if (!session_id || !toolCallId) {
          return c.json({ error: 'session_id and toolCallId are required' }, 400);
        }

        const resolved = resolveLocalToolResult(session_id, toolCallId, output, error);
        if (resolved) {
          logger.info(`[ClientTools] Tool result received: ${toolCallId} (session: ${session_id})`);
        } else {
          logger.warn(`[ClientTools] No pending request for tool result: ${toolCallId} (session: ${session_id})`);
        }

        return c.json({ ok: true });
      })
  );
}
