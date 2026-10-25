/**
 * 团队连接器（MCP 客户端）管理 —— 只给超级管理员（`/api/admin/*` 守卫）。
 *
 * GET    /api/admin/connectors                 → { connectors: ConnectorView[] }   团队连接器
 * GET    /api/admin/connectors/catalog         → { entries: ConnectorCatalogEntry[] } 官方目录（标出已安装的）
 * POST   /api/admin/connectors/probe           { url, transport?, private_network? } → ConnectorProbeResult
 * POST   /api/admin/connectors                 ConnectorInput → ConnectorView（201）
 * PATCH  /api/admin/connectors/:id             ConnectorUpdate → ConnectorView
 * DELETE /api/admin/connectors/:id             → { ok }
 * POST   /api/admin/connectors/:id/refresh     → { connector, ok, error? }   用管理员自己的凭证重新列工具
 * POST   /api/admin/connectors/:id/oauth/start { client? } → { authorize_url }  团队共享登录（auth_mode=shared + oauth）
 * DELETE /api/admin/connectors/:id/oauth       → ConnectorView               撤销并清掉团队共享登录
 *
 * 密钥只写不读：shared_secret / oauth_client_secret 永不返回、不进日志。
 * 改地址或认证方式会在同一事务里删掉所有成员凭证（connectors/manage.ts）。
 */

import { Hono, type Context } from 'hono';
import { getDb } from '@greenhouse/db';
import type { ConnectorInput, ConnectorTransport, ConnectorUpdate } from '@greenhouse/types/connectors';
import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import { listCatalog, probeConnectorAuth } from '../connectors/catalog.js';
import { refreshConnectorDirectory, refreshConnectorTools, toConnectorView } from '../connectors/directory.js';
import { ConnectorInputError, createConnector, deleteConnector, updateConnector } from '../connectors/manage.js';
import { connectorUrlProblem, policyFor } from '../connectors/network.js';
import {
  beginConnectorSignIn,
  ConnectorSignInError,
  connectorRedirectUri,
  revokeSharedSignIn,
} from '../connectors/oauth.js';
import { auditConnectorChange } from '../connectors/audit.js';

async function body<T>(c: Context): Promise<T | null> {
  const value = (await c.req.json().catch(() => null)) as unknown;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : null;
}

async function teamRow(id: string) {
  const row = await getDb().mcpConnectors.getById(id);
  return row && row.scope === 'team' ? row : null;
}

async function viewOf(id: string) {
  const db = getDb();
  const row = await db.mcpConnectors.getById(id);
  if (!row) return null;
  const counts = await db.mcpConnectors.countConnections([row.id]);
  return toConnectorView(row, { connectionCount: counts.get(row.id) ?? 0 });
}

const adminConnectorRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const db = getDb();
    const rows = await db.mcpConnectors.listTeam();
    const counts = await db.mcpConnectors.countConnections(rows.map((r) => r.id));
    return c.json({
      connectors: rows.map((row) => toConnectorView(row, { connectionCount: counts.get(row.id) ?? 0 })),
    });
  })
  .get('/catalog', async (c) => {
    const installed = new Map(
      (await getDb().mcpConnectors.listTeam()).filter((r) => r.catalog_id).map((r) => [r.catalog_id!, r.slug]),
    );
    return c.json({
      entries: listCatalog().map((entry) => ({ ...entry, installed_slug: installed.get(entry.id) ?? null })),
    });
  })
  .post('/probe', async (c) => {
    const input = await body<{ url?: unknown; transport?: unknown; private_network?: unknown }>(c);
    const url = typeof input?.url === 'string' ? input.url.trim() : '';
    const privateNetwork = input?.private_network === true;
    const problem = connectorUrlProblem(url, { privateNetwork });
    if (problem) return c.json({ error: problem }, 400);
    const transport: ConnectorTransport = input?.transport === 'sse' ? 'sse' : 'streamable_http';
    return c.json(
      await probeConnectorAuth(url, transport, policyFor({ scope: 'team', private_network: privateNetwork, url })),
    );
  })
  .post('/', async (c) => {
    const user = getAuthUser(c);
    const input = await body<ConnectorInput>(c);
    if (!input) return c.json({ error: 'A JSON body is required.' }, 400);
    try {
      const row = await createConnector(getDb(), { userId: user.id, role: user.role }, 'team', input);
      return c.json((await viewOf(row.id))!, 201);
    } catch (err) {
      if (err instanceof ConnectorInputError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  })
  .patch('/:id', async (c) => {
    const user = getAuthUser(c);
    const row = await teamRow(c.req.param('id'));
    if (!row) return c.json({ error: 'Connector not found.' }, 404);
    const patch = await body<ConnectorUpdate>(c);
    if (!patch) return c.json({ error: 'A JSON body is required.' }, 400);
    try {
      const updated = await updateConnector(getDb(), { userId: user.id, role: user.role }, row, patch);
      return c.json((await viewOf(updated.id))!);
    } catch (err) {
      if (err instanceof ConnectorInputError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  })
  .delete('/:id', async (c) => {
    const user = getAuthUser(c);
    const row = await teamRow(c.req.param('id'));
    if (!row) return c.json({ error: 'Connector not found.' }, 404);
    await deleteConnector(getDb(), { userId: user.id, role: user.role }, row);
    return c.json({ ok: true });
  })
  .post('/:id/refresh', async (c) => {
    const user = getAuthUser(c);
    const row = await teamRow(c.req.param('id'));
    if (!row) return c.json({ error: 'Connector not found.' }, 404);
    const result = await refreshConnectorTools(getDb(), row, user.id);
    return c.json({ connector: (await viewOf(row.id))!, ok: result.ok, error: result.error ?? null });
  })
  .post('/:id/oauth/start', async (c) => {
    const user = getAuthUser(c);
    const row = await teamRow(c.req.param('id'));
    if (!row || !row.enabled) return c.json({ error: 'Connector not found.' }, 404);
    if (row.auth_mode !== 'shared' || row.auth_kind !== 'oauth') {
      return c.json({ error: 'This connector does not use a team sign-in.' }, 400);
    }
    const redirectUri = connectorRedirectUri(c.req.url);
    if (!redirectUri) return c.json({ error: 'The instance address is unknown — set PUBLIC_BASE_URL.' }, 400);
    const input = await body<{ client?: unknown }>(c);
    try {
      const url = await beginConnectorSignIn(getDb(), row, {
        owner: { kind: 'shared' },
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
  .delete('/:id/oauth', async (c) => {
    const user = getAuthUser(c);
    const row = await teamRow(c.req.param('id'));
    if (!row) return c.json({ error: 'Connector not found.' }, 404);
    if (row.auth_mode === 'shared' && row.auth_kind === 'oauth' && row.shared_secret_enc) {
      await revokeSharedSignIn(row);
      await getDb().mcpConnectors.setSharedSecret(row.id, null);
      await auditConnectorChange(getDb(), { userId: user.id, connectorId: row.id, action: 'disconnectTeamSignIn' });
      await refreshConnectorDirectory(getDb());
    }
    return c.json((await viewOf(row.id))!);
  });

export default adminConnectorRoutes;
