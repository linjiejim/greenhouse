/**
 * Agent access — what a member sees about their own external agents.
 *
 * GET    /api/agent-access/overview              the MCP endpoint to connect to
 * GET    /api/agent-access/connections           my connected agents and when each last reached MCP (connect wizard)
 * GET    /api/agent-access/writes                my agents' recent writes, newest first
 * GET    /api/agent-access/gateway               the model gateway: on/off, base URLs, models, my keys + this month's spend
 * POST   /api/agent-access/gateway/keys          create a key {name, allowed_models?, expires_at?} → the secret, once
 * DELETE /api/agent-access/gateway/keys/:id      revoke one of my keys
 *
 * Writes run as the member and are recorded as Runtime runs (see
 * agent-access/governed-write.ts); this is the read side of that record.
 * Gateway keys are the member's own (gateway/keys.ts); creating one needs the
 * workspace switch on, revoking never does. Both are platform-audited.
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import type { GatewayKeyCreateInput, GatewayKeyCreated, GatewayOverview } from '@greenhouse/types/agent-access';

import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import { getMcpResourceUrl } from '../platform/oauth.js';
import { agentWriteView } from '../agent-access/governed-write.js';
import { checkAgentConnections } from '../hub-context/connections.js';
import type { AgentConnectionsCheck } from '@greenhouse/types/hub-context';
import {
  gatewayAnthropicBaseUrl,
  gatewayBaseUrl,
  gatewayModelViews,
  generateGatewaySecret,
  isGatewayEnabled,
  MAX_ACTIVE_GATEWAY_KEYS,
  monthSpendByKey,
  parseGatewayKeyInput,
  recordGatewayKeyAudit,
  toGatewayKeyView,
} from '../gateway/keys.js';

const MANAGE_OWN_GATEWAY_KEYS = 'platform.gateway.manageOwn';

export function createAgentAccessRoutes() {
  return new Hono<AppEnv>()
    .get('/overview', (c) => c.json({ mcp_url: getMcpResourceUrl() }))

    .get('/connections', async (c) => {
      const user = getAuthUser(c);
      const check: AgentConnectionsCheck = await checkAgentConnections(getDb(), user.id);
      return c.json(check);
    })

    .get('/writes', async (c) => {
      const user = getAuthUser(c);
      const db = getDb();
      const recent = await db.runtime.listRuns({ owner_user_id: user.id, kinds: ['agent_write'], limit: 50 });
      const rows = await Promise.all(recent.items.map((run) => agentWriteView(db, run)));
      // Payloads are recursive JSON; keep Hono from instantiating their type.
      return c.json({ writes: rows as unknown[] });
    })

    .get('/gateway', async (c) => {
      const user = getAuthUser(c);
      const db = getDb();
      const [keys, spend] = await Promise.all([db.gatewayKeys.listByUser(user.id), monthSpendByKey(db, user.id)]);
      const overview: GatewayOverview = {
        enabled: await isGatewayEnabled(),
        base_url: gatewayBaseUrl(),
        anthropic_base_url: gatewayAnthropicBaseUrl(),
        models: gatewayModelViews(),
        keys: keys.map((row) => toGatewayKeyView(row, spend.get(row.id))),
      };
      return c.json(overview);
    })

    .post('/gateway/keys', async (c) => {
      const user = getAuthUser(c);
      if (!(await isGatewayEnabled())) {
        return c.json({ error: 'The model gateway is turned off. An administrator must enable it first.' }, 403);
      }
      const body = (await c.req.json().catch(() => null)) as Partial<GatewayKeyCreateInput> | null;
      const input = parseGatewayKeyInput(body);
      if (!input.ok) return c.json({ error: input.error }, 400);
      const db = getDb();
      if ((await db.gatewayKeys.countActiveByUser(user.id)) >= MAX_ACTIVE_GATEWAY_KEYS) {
        return c.json(
          { error: `You already have ${MAX_ACTIVE_GATEWAY_KEYS} active keys. Revoke one before creating another.` },
          409,
        );
      }
      const secret = generateGatewaySecret();
      const row = await db.gatewayKeys.create({
        user_id: user.id,
        name: input.name,
        secret,
        allowed_models: input.allowed_models,
        expires_at: input.expires_at,
      });
      await recordGatewayKeyAudit(db, c, user, {
        actionId: 'createGatewayKey',
        key: row,
        capability: MANAGE_OWN_GATEWAY_KEYS,
      });
      const created: GatewayKeyCreated = { key: toGatewayKeyView(row), secret };
      return c.json(created, 201);
    })

    .delete('/gateway/keys/:id', async (c) => {
      const user = getAuthUser(c);
      const db = getDb();
      const result = await db.gatewayKeys.revoke({ id: c.req.param('id'), user_id: user.id, revoked_by: user.id });
      if (!result) return c.json({ error: 'Gateway key not found' }, 404);
      if (result.changed) {
        await recordGatewayKeyAudit(db, c, user, {
          actionId: 'revokeGatewayKey',
          key: result.row,
          capability: MANAGE_OWN_GATEWAY_KEYS,
        });
      }
      return c.json({ ok: true as const, key: toGatewayKeyView(result.row) });
    });
}
