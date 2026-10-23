/**
 * Agent access — what a member sees about their own external agents.
 *
 * GET /api/agent-access/overview   the MCP endpoint to connect to
 * GET /api/agent-access/writes     my agents' recent writes, newest first
 *
 * Writes run as the member and are recorded as Runtime runs (see
 * agent-access/governed-write.ts); this is the read side of that record.
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';

import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import { getMcpResourceUrl } from '../platform/oauth.js';
import { agentWriteView } from '../agent-access/governed-write.js';

export function createAgentAccessRoutes() {
  return new Hono<AppEnv>()
    .get('/overview', (c) => c.json({ mcp_url: getMcpResourceUrl() }))

    .get('/writes', async (c) => {
      const user = getAuthUser(c);
      const db = getDb();
      const recent = await db.runtime.listRuns({ owner_user_id: user.id, kinds: ['agent_write'], limit: 50 });
      const rows = await Promise.all(recent.items.map((run) => agentWriteView(db, run)));
      // Payloads are recursive JSON; keep Hono from instantiating their type.
      return c.json({ writes: rows as unknown[] });
    });
}
