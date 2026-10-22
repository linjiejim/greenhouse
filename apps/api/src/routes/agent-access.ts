/**
 * Agent access — what a member sees and decides about their own external agents.
 *
 * GET    /api/agent-access/overview            MCP endpoint + counts for the page header
 * GET    /api/agent-access/requests?view=      pending (waiting for me) | recent (my agents' writes)
 * POST   /api/agent-access/requests/:interruptId/decision   { decision: approve|reject, grant_days? }
 * GET    /api/agent-access/grants              my standing grants (live first)
 * POST   /api/agent-access/grants              { tool_id, action?, client_id?, days }
 * DELETE /api/agent-access/grants/:id
 * GET    /api/agent-access/write-tools         write tools I can pre-approve
 *
 * Every row is the caller's own (or, for a super, a machine client's request
 * assigned to them). Decisions go through agent-access/governed-write.ts so a
 * write runs at most once and against the CURRENT grant.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { getDb, AGENT_WRITE_GRANT_DAYS } from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';

import type { ToolRegistry } from '../agent.js';
import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import { MUTATING_PROXY_ALLOWLIST, getToolMeta, MCP_EXPOSED_TOOL_IDS } from '../tools/registry.js';
import { getMcpResourceUrl } from '../platform/oauth.js';
import { RuntimeKernelError } from '@greenhouse/db';
import {
  AgentWriteError,
  agentWriteView,
  decideAgentWrite,
  type AgentWriteView,
} from '../agent-access/governed-write.js';
import { legacyConfirmEnabled, resolveApprovedWriteContext } from '../agent-access/context.js';

const decisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  grant_days: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]).optional(),
});

const grantSchema = z.object({
  tool_id: z.string().min(1).max(200),
  action: z.string().min(1).max(200).nullable().optional(),
  client_id: z.string().min(1).max(200).nullable().optional(),
  days: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]),
});

function writeErrorStatus(error: AgentWriteError): 400 | 403 | 404 | 409 {
  if (error.code === 'not_found') return 404;
  if (error.code === 'forbidden') return 403;
  if (error.code === 'not_pending') return 409;
  return 400;
}

/** Pending view row: the request plus who is waiting on whom. */
interface PendingRow extends AgentWriteView {
  owner_user_id: string;
  owner_nickname: string | null;
}

export function createAgentAccessRoutes(toolRegistry: ToolRegistry) {
  return new Hono<AppEnv>()
    .get('/overview', async (c) => {
      const user = getAuthUser(c);
      const db = getDb();
      const [pending, grants] = await Promise.all([
        db.runtime.listPendingInterrupts(user.id, 200),
        db.agentWriteGrants.listForUser(user.id),
      ]);
      const now = Date.now();
      return c.json({
        mcp_url: getMcpResourceUrl(),
        legacy_confirm: await legacyConfirmEnabled(),
        pending_count: pending.length,
        live_grant_count: grants.filter((g) => !g.revoked_at && Date.parse(g.expires_at) > now).length,
      });
    })

    .get('/requests', async (c) => {
      const user = getAuthUser(c);
      const db = getDb();
      const view = c.req.query('view') === 'recent' ? 'recent' : 'pending';
      if (view === 'pending') {
        const interrupts = await db.runtime.listPendingInterrupts(user.id, 200);
        const rows: PendingRow[] = [];
        for (const interrupt of interrupts) {
          const run = await db.runtime.getRun(interrupt.run_id);
          if (!run || run.kind !== 'agent_write' || run.status !== 'waiting') continue;
          const owner = run.owner_user_id === user.id ? null : await db.users.getById(run.owner_user_id);
          rows.push({
            ...(await agentWriteView(db, run)),
            owner_user_id: run.owner_user_id,
            owner_nickname: owner?.nickname ?? null,
          });
        }
        // Payloads are recursive JSON; keep Hono from instantiating their type.
        return c.json({ requests: rows as unknown[] });
      }
      const recent = await db.runtime.listRuns({ owner_user_id: user.id, kinds: ['agent_write'], limit: 50 });
      const rows = await Promise.all(recent.items.map((run) => agentWriteView(db, run)));
      return c.json({ requests: rows as unknown[] });
    })

    .post('/requests/:interruptId/decision', async (c) => {
      const user = getAuthUser(c);
      const parsed = decisionSchema.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.json({ error: 'decision must be approve or reject' }, 400);
      try {
        const view = await decideAgentWrite({
          db: getDb(),
          interruptId: c.req.param('interruptId'),
          actor: { id: user.id, role: user.role },
          decision: parsed.data.decision,
          ...(parsed.data.grant_days ? { grantDays: parsed.data.grant_days } : {}),
          resolveContext: (run, input) => resolveApprovedWriteContext(getDb(), toolRegistry, run, input),
        });
        return c.json({ request: view as unknown });
      } catch (error) {
        if (error instanceof AgentWriteError)
          return c.json({ error: error.message, code: error.code }, writeErrorStatus(error));
        // A second click racing the first loses on the interrupt/run version.
        if (error instanceof RuntimeKernelError) {
          return c.json({ error: 'This request has already been decided', code: 'not_pending' }, 409);
        }
        return c.json({ error: toErrorMessage(error) }, 500);
      }
    })

    .get('/grants', async (c) => {
      const user = getAuthUser(c);
      const grants = await getDb().agentWriteGrants.listForUser(user.id);
      return c.json({
        grants: grants.map((grant) => ({ ...grant, tool_name: getToolMeta(grant.tool_id)?.name ?? grant.tool_id })),
      });
    })

    .post('/grants', async (c) => {
      const user = getAuthUser(c);
      const parsed = grantSchema.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) {
        return c.json({ error: `tool_id and days (${AGENT_WRITE_GRANT_DAYS.join('/')}) are required` }, 400);
      }
      const { tool_id, days } = parsed.data;
      const action = parsed.data.action ?? null;
      const clientId = parsed.data.client_id ?? null;
      if (!MUTATING_PROXY_ALLOWLIST.has(tool_id) || !MCP_EXPOSED_TOOL_IDS.has(tool_id)) {
        return c.json({ error: 'Not a write tool agents can use' }, 400);
      }
      if (action && /(^|\.)(delete|remove|purge|destroy|drop)(_|$)/.test(action)) {
        return c.json({ error: 'Deletes always need approval and cannot be allowed in advance' }, 400);
      }
      if (clientId) {
        const grant = await getDb().platformOAuth.getGrantByPrincipal(user.id, clientId, getMcpResourceUrl());
        if (!grant || grant.status !== 'active')
          return c.json({ error: 'That agent is not connected to your account' }, 400);
      }
      const grant = await getDb().agentWriteGrants.create({
        user_id: user.id,
        client_id: clientId,
        tool_id,
        action,
        days,
        created_via: 'settings',
      });
      return c.json({ grant }, 201);
    })

    .delete('/grants/:id', async (c) => {
      const user = getAuthUser(c);
      const revoked = await getDb().agentWriteGrants.revoke(user.id, c.req.param('id'));
      return revoked ? c.json({ ok: true }) : c.json({ error: 'Grant not found' }, 404);
    })

    .get('/write-tools', async (c) => {
      const tools = [...MCP_EXPOSED_TOOL_IDS]
        .filter((id) => MUTATING_PROXY_ALLOWLIST.has(id))
        .map((id) => {
          const meta = getToolMeta(id);
          return { id, name: meta?.name ?? id, group: meta?.surface?.mcp ?? null };
        });
      return c.json({ tools });
    });
}
