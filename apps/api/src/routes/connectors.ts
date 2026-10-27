/**
 * 成员自己的连接器 —— 内部成员且持有 `mcp_call` 工具（`requireInternal` + 本文件的守卫）。
 *
 * GET    /api/me/connectors                      → { team: ConnectorMemberView[], personal: ConnectorView[] }
 * POST   /api/me/connectors/personal             ConnectorInput → ConnectorView（201）   我的个人连接器
 * PATCH  /api/me/connectors/personal/:id         ConnectorUpdate → ConnectorView
 * DELETE /api/me/connectors/personal/:id         → { ok }
 * POST   /api/me/connectors/personal/:id/refresh → { connector, ok, error? }
 * PUT    /api/me/connectors/:id/key              { key } → { connector: ConnectorMemberView, ok, error? }  保存我的 Key 并试连
 * POST   /api/me/connectors/:id/oauth/start      { client?: 'web' | 'mobile' } → { authorize_url }
 * POST   /api/me/connectors/oauth/finish         { code, state } → { connector_id, connector: ConnectorMemberView }
 * DELETE /api/me/connectors/:id/connection       → { ok }   断开（OAuth 先尽力撤销）
 * POST   /api/me/connectors/:id/test             → { ok, error?, tool_count }
 *
 * 公开回调（不带 Bearer，见 auth/middleware.ts PUBLIC_PATHS，限流 30/分钟）：
 * GET    /api/connectors/oauth/callback?code&state[&error]
 *   只把浏览器送回应用（web：客户端 `/connectors/oauth-finish#…`，mobile：`greenhouse://connectors/oauth-finish?…`），
 *   不写任何东西；登录态的应用再调 finish，finish 拒绝不是本人发起的 state。
 *
 * 不放在 `/api/mcp…` 下：那是 Greenhouse 自己的 MCP 服务器的前缀。
 */

import { Hono, type Context, type Next } from 'hono';
import { getDb, type McpConnectorRow } from '@greenhouse/db';
import { CLIENT_ROUTES, clientRouteUrl } from '@greenhouse/types/client-routes';
import { CONNECTOR_SECRET_MAX, type ConnectorInput, type ConnectorUpdate } from '@greenhouse/types/connectors';
import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import { resolveUserTools } from '../agent.js';
import { auditConnectorChange } from '../connectors/audit.js';
import { discoverMcpTools, describeMcpError } from '../connectors/client.js';
import { redactSecrets, resolveConnectTarget, sealMemberKey } from '../connectors/credentials.js';
import {
  discoverIfEmpty,
  refreshConnectorDirectory,
  refreshConnectorTools,
  toConnectorView,
  toMemberView,
} from '../connectors/directory.js';
import { ConnectorInputError, createConnector, deleteConnector, updateConnector } from '../connectors/manage.js';
import {
  beginConnectorSignIn,
  CONNECTOR_APP_REDIRECT,
  connectorBaseUrl,
  connectorRedirectUri,
  ConnectorSignInError,
  finishConnectorSignIn,
  openSignInState,
  revokeMemberSignIn,
  withSignInLock,
} from '../connectors/oauth.js';
import { MCP_CALL_TOOL_ID } from '../tools/mcp-call.js';

async function body<T>(c: Context): Promise<T | null> {
  const value = (await c.req.json().catch(() => null)) as unknown;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : null;
}

/** Connectors are reached through mcp_call: a member without the tool has nothing to connect. */
async function requireConnectorTool(c: Context, next: Next) {
  const user = getAuthUser(c);
  const { activeTools } = await resolveUserTools(user.id, user.role);
  if (!activeTools.includes(MCP_CALL_TOOL_ID)) return c.json({ error: 'Connectors are not available to you.' }, 403);
  await next();
}

/** A connector this member may connect to: an enabled team one, or their own personal one. */
async function usableRow(userId: string, id: string): Promise<McpConnectorRow | null> {
  const row = await getDb().mcpConnectors.getById(id);
  if (!row || !row.enabled) return null;
  if (row.scope === 'personal' && row.owner_user_id !== userId) return null;
  return row;
}

async function personalRow(userId: string, id: string): Promise<McpConnectorRow | null> {
  const row = await getDb().mcpConnectors.getById(id);
  return row && row.scope === 'personal' && row.owner_user_id === userId ? row : null;
}

async function memberView(userId: string, row: McpConnectorRow) {
  return toMemberView(row, await getDb().mcpConnectors.getConnection(userId, row.id));
}

async function personalView(userId: string, id: string) {
  const db = getDb();
  const row = await db.mcpConnectors.getById(id);
  return row ? toConnectorView(row, { connection: await db.mcpConnectors.getConnection(userId, row.id) }) : null;
}

/** Try the member's credential: list the tools once (and fill an empty cache). */
async function testConnection(userId: string, row: McpConnectorRow) {
  const db = getDb();
  const resolved = await resolveConnectTarget(db, row, userId);
  if (!resolved.ok) return { ok: false as const, error: resolved.error, tool_count: 0 };
  try {
    const list = () => discoverMcpTools(resolved.target);
    const tools =
      resolved.target.authProvider && resolved.owner
        ? await withSignInLock(row.id, resolved.owner, list)
        : await list();
    if (row.auth_mode === 'per_member') await db.mcpConnectors.markConnection(userId, row.id, 'active');
    if (!Array.isArray(row.tools) || row.tools.length === 0) await discoverIfEmpty(db, row.id, userId);
    return { ok: true as const, error: null, tool_count: tools.length };
  } catch (err) {
    const error = redactSecrets(describeMcpError(err), resolved.secrets);
    if (row.auth_mode === 'per_member') await db.mcpConnectors.markConnection(userId, row.id, 'error', error);
    return { ok: false as const, error, tool_count: 0 };
  }
}

export const memberConnectorRoutes = new Hono<AppEnv>()
  .use('*', requireConnectorTool)
  .get('/', async (c) => {
    const user = getAuthUser(c);
    const db = getDb();
    const [team, personal, connections] = await Promise.all([
      db.mcpConnectors.listTeam(),
      db.mcpConnectors.listPersonal(user.id),
      db.mcpConnectors.listConnectionsForUser(user.id),
    ]);
    const byProvider = new Map(connections.map((row) => [row.provider, row]));
    return c.json({
      team: team.filter((row) => row.enabled).map((row) => toMemberView(row, byProvider.get(`mcp:${row.id}`))),
      personal: personal.map((row) => toConnectorView(row, { connection: byProvider.get(`mcp:${row.id}`) })),
    });
  })
  .post('/personal', async (c) => {
    const user = getAuthUser(c);
    const input = await body<ConnectorInput>(c);
    if (!input) return c.json({ error: 'A JSON body is required.' }, 400);
    try {
      const row = await createConnector(getDb(), { userId: user.id, role: user.role }, 'personal', input);
      return c.json((await personalView(user.id, row.id))!, 201);
    } catch (err) {
      if (err instanceof ConnectorInputError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  })
  .patch('/personal/:id', async (c) => {
    const user = getAuthUser(c);
    const row = await personalRow(user.id, c.req.param('id'));
    if (!row) return c.json({ error: 'Connector not found.' }, 404);
    const patch = await body<ConnectorUpdate>(c);
    if (!patch) return c.json({ error: 'A JSON body is required.' }, 400);
    try {
      await updateConnector(getDb(), { userId: user.id, role: user.role }, row, patch);
      return c.json((await personalView(user.id, row.id))!);
    } catch (err) {
      if (err instanceof ConnectorInputError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  })
  .delete('/personal/:id', async (c) => {
    const user = getAuthUser(c);
    const row = await personalRow(user.id, c.req.param('id'));
    if (!row) return c.json({ error: 'Connector not found.' }, 404);
    await deleteConnector(getDb(), { userId: user.id, role: user.role }, row);
    return c.json({ ok: true });
  })
  .post('/personal/:id/refresh', async (c) => {
    const user = getAuthUser(c);
    const row = await personalRow(user.id, c.req.param('id'));
    if (!row) return c.json({ error: 'Connector not found.' }, 404);
    const result = await refreshConnectorTools(getDb(), row, user.id);
    return c.json({ connector: (await personalView(user.id, row.id))!, ok: result.ok, error: result.error ?? null });
  })
  .post('/oauth/finish', async (c) => {
    const user = getAuthUser(c);
    const input = await body<{ code?: unknown; state?: unknown }>(c);
    try {
      const { connector, owner } = await finishConnectorSignIn(getDb(), {
        code: typeof input?.code === 'string' ? input.code : undefined,
        state: typeof input?.state === 'string' ? input.state : undefined,
        caller: { id: user.id, role: user.role },
      });
      await auditConnectorChange(getDb(), {
        userId: user.id,
        connectorId: connector.id,
        action: owner.kind === 'shared' ? 'connectTeamSignIn' : 'connectConnector',
        summary: { slug: connector.slug, via: 'oauth' },
      });
      await discoverIfEmpty(getDb(), connector.id, user.id);
      const latest = (await getDb().mcpConnectors.getById(connector.id)) ?? connector;
      return c.json({ connector_id: connector.id, connector: await memberView(user.id, latest) });
    } catch (err) {
      if (err instanceof ConnectorSignInError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  })
  .put('/:id/key', async (c) => {
    const user = getAuthUser(c);
    const row = await usableRow(user.id, c.req.param('id'));
    if (!row) return c.json({ error: 'Connector not found.' }, 404);
    if (row.auth_mode !== 'per_member' || row.auth_kind !== 'key') {
      return c.json({ error: 'This connector does not take a key from you.' }, 400);
    }
    const input = await body<{ key?: unknown }>(c);
    const key = typeof input?.key === 'string' ? input.key.trim() : '';
    if (!key || key.length > CONNECTOR_SECRET_MAX || /[\r\n]/.test(key)) {
      return c.json({ error: 'Paste the key as one line.' }, 400);
    }
    const db = getDb();
    await db.mcpConnectors.saveConnection(user.id, row.id, {
      credential: sealMemberKey(row.id, user.id, key),
      metadata: { connected_via: 'key' },
    });
    await auditConnectorChange(db, {
      userId: user.id,
      connectorId: row.id,
      action: 'connectConnector',
      summary: { slug: row.slug, via: 'key' },
    });
    const test = await testConnection(user.id, row);
    await refreshConnectorDirectory(db);
    const latest = (await db.mcpConnectors.getById(row.id)) ?? row;
    return c.json({ connector: await memberView(user.id, latest), ok: test.ok, error: test.error });
  })
  .post('/:id/oauth/start', async (c) => {
    const user = getAuthUser(c);
    const row = await usableRow(user.id, c.req.param('id'));
    if (!row) return c.json({ error: 'Connector not found.' }, 404);
    if (row.auth_mode !== 'per_member' || row.auth_kind !== 'oauth') {
      return c.json({ error: 'This connector does not sign in with your account.' }, 400);
    }
    const redirectUri = connectorRedirectUri(c.req.url);
    if (!redirectUri) return c.json({ error: 'The instance address is unknown — set PUBLIC_BASE_URL.' }, 400);
    const input = await body<{ client?: unknown }>(c);
    try {
      const url = await beginConnectorSignIn(getDb(), row, {
        owner: { kind: 'member', userId: user.id },
        actorUserId: user.id,
        redirectUri,
        client: input?.client === 'mobile' ? 'mobile' : 'web',
      });
      return c.json({ authorize_url: url });
    } catch (err) {
      if (err instanceof ConnectorSignInError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  })
  .delete('/:id/connection', async (c) => {
    const user = getAuthUser(c);
    const db = getDb();
    const row = await db.mcpConnectors.getById(c.req.param('id'));
    if (!row || (row.scope === 'personal' && row.owner_user_id !== user.id)) {
      return c.json({ error: 'Connector not found.' }, 404);
    }
    const conn = await db.mcpConnectors.getConnection(user.id, row.id);
    if (conn) {
      if (row.auth_kind === 'oauth') await revokeMemberSignIn(row, user.id, conn);
      await db.mcpConnectors.deleteConnection(user.id, row.id);
      await auditConnectorChange(db, {
        userId: user.id,
        connectorId: row.id,
        action: 'disconnectConnector',
        summary: { slug: row.slug },
      });
    }
    return c.json({ ok: true });
  })
  .post('/:id/test', async (c) => {
    const user = getAuthUser(c);
    const row = await usableRow(user.id, c.req.param('id'));
    if (!row) return c.json({ error: 'Connector not found.' }, 404);
    return c.json(await testConnection(user.id, row));
  });

/** Where the public callback sends the person: the app that started the sign-in. */
function finishTarget(requestUrl: string, client: 'web' | 'mobile', params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  if (client === 'mobile') return `${CONNECTOR_APP_REDIRECT}?${query}`;
  // The provider's code rides in the fragment, out of the client host's logs.
  return clientRouteUrl(connectorBaseUrl(requestUrl) ?? '', CLIENT_ROUTES.connectorFinish, { fragment: params });
}

export const connectorOAuthCallbackRoutes = new Hono<AppEnv>().get('/oauth/callback', (c) => {
  const code = c.req.query('code') ?? '';
  const state = c.req.query('state') ?? '';
  const providerError = c.req.query('error');
  // Opening the state only tells us which app to return to; finish checks who.
  const opened = openSignInState(state);
  const client = opened?.c ?? 'web';
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  if (!opened) return c.redirect(finishTarget(c.req.url, client, { error: 'invalid_state' }));
  if (providerError) {
    return c.redirect(finishTarget(c.req.url, client, { error: providerError.slice(0, 64), connector_id: opened.s }));
  }
  if (!code) return c.redirect(finishTarget(c.req.url, client, { error: 'missing_code', connector_id: opened.s }));
  return c.redirect(finishTarget(c.req.url, client, { code, state }));
});
