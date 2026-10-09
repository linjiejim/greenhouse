/**
 * Connectors — a member's own connections to installed MCP servers
 * (spec 20261009-mcp-connectors).
 *
 * GET    /api/connectors                              — the connectors I can use + my status on each
 * POST   /api/connectors/:id/authorize                — oauth: start my sign-in, answer the provider's URL
 * PUT    /api/connectors/:id/key                      — per_user: verify and store my own key
 * POST   /api/connectors/:id/test                     — list the tools with my connection
 * DELETE /api/connectors/:id                          — disconnect (an OAuth sign-in is also revoked, best effort)
 * GET    /api/connectors/oauth/callback               — PUBLIC: the provider sends my browser back here
 * GET    /api/connectors/oauth/client-metadata.json   — PUBLIC: the instance's client-id metadata document
 *
 * Every route but the two public ones needs an internal member who holds the
 * `mcp_call` tool (super always does). The prefix is deliberately NOT
 * `/api/mcp…`: `isPublicPath` exempts that whole prefix (Greenhouse's own MCP
 * server authenticates itself), which would have made these routes public.
 *
 * Credentials only ever travel inward: no response carries a key or token.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { getDb, serverIdOfConnectionProvider, type DatabaseProvider, type McpServerRow } from '@greenhouse/db';
import {
  isPersonalAuthMode,
  MCP_CONNECT_MESSAGE_TYPE,
  type McpConnectionStatus,
  type McpConnectorView,
} from '@greenhouse/types/mcp-servers';
import { escapeHtml } from '@greenhouse/utils/html';
import { safeJsonParse } from '@greenhouse/utils/json';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { AppEnv } from '../app-env.js';
import { getAuthUser, requireInternal, type AuthUser } from '../auth/middleware.js';
import { isEncryptionConfigured } from '../auth/crypto.js';
import { resolveUserTools } from '../agent.js';
import { describeMcpError, discoverMcpTools, explainFailedConnect } from '../mcp-client/client.js';
import {
  placeCredential,
  redactSecrets,
  resolveConnectTarget,
  sealMemberCredential,
} from '../mcp-client/credentials.js';
import { callableTools, discoverIfEmpty, refreshMcpDirectory } from '../mcp-client/directory.js';
import {
  beginConnectorSignIn,
  ConnectorOAuthProvider,
  ConnectorSignInError,
  connectorBaseUrl,
  connectorClientMetadata,
  connectorClientMetadataUrl,
  connectorRedirectUri,
  finishConnectorSignIn,
  revokeConnectorSignIn,
  withConnectionLock,
} from '../mcp-client/oauth.js';

const keySchema = z.object({ key: z.string().trim().min(1).max(4096) });

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function mayUseConnectors(user: Pick<AuthUser, 'id' | 'role'>): Promise<boolean> {
  if (user.role === 'super') return true;
  const { activeTools } = await resolveUserTools(user.id, user.role);
  return activeTools.includes('mcp_call');
}

/** A member's standing on every enabled connector. */
async function connectorViews(db: DatabaseProvider, userId: string): Promise<McpConnectorView[]> {
  const [rows, connections] = await Promise.all([db.mcpServers.listEnabled(), db.mcpServers.listConnections(userId)]);
  const byServer = new Map(connections.map((row) => [serverIdOfConnectionProvider(row.provider), row]));
  return rows.map((row) => {
    const tools = callableTools(row);
    const connection = byServer.get(row.id);
    let status: McpConnectionStatus = 'not_needed';
    if (isPersonalAuthMode(row.auth_mode)) {
      const usable = row.auth_mode === 'oauth' ? connection?.access_token : connection?.provider_credential;
      status = usable ? 'connected' : connection && row.auth_mode === 'oauth' ? 'expired' : 'not_connected';
    }
    const meta = safeJsonParse(connection?.metadata, {}) as { error?: unknown };
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      auth_mode: row.auth_mode,
      credential_help: row.credential_help,
      credential_url: row.credential_url,
      catalog_id: row.catalog_id,
      tool_count: tools.length,
      read_only_tool_count: tools.filter((tool) => tool.read_only).length,
      status,
      connected_at: status === 'connected' && connection ? connection.updated_at : null,
      error: status === 'expired' && typeof meta.error === 'string' ? meta.error : null,
    };
  });
}

/** The enabled connector a member is acting on, or the response explaining why not. */
async function loadForMember(
  c: Context<AppEnv>,
): Promise<{ ok: true; user: AuthUser; row: McpServerRow } | { ok: false; status: 400 | 403 | 404; error: string }> {
  const user = getAuthUser(c);
  const id = parseId(c.req.param('id') ?? '');
  if (id === null) return { ok: false, status: 400, error: 'Invalid connector id' };
  if (!(await mayUseConnectors(user))) {
    return { ok: false, status: 403, error: 'External tools are not enabled for your account — ask an administrator.' };
  }
  const row = await getDb().mcpServers.getById(id);
  if (!row || !row.enabled) return { ok: false, status: 404, error: `Connector ${id} not found` };
  return { ok: true, user, row };
}

// ─── The page the provider redirects the browser to ──────

type CallbackLocale = 'en' | 'zh';

const CALLBACK_COPY = {
  en: {
    okTitle: (name: string) => `Connected to ${name}`,
    okBody: 'You can close this window and go back to Greenhouse.',
    failTitle: 'Could not connect',
    back: 'Back to Greenhouse',
  },
  zh: {
    okTitle: (name: string) => `已连接 ${name}`,
    okBody: '可以关闭这个窗口，回到 Greenhouse 继续。',
    failTitle: '连接没有成功',
    back: '回到 Greenhouse',
  },
} as const;

/**
 * Self-contained, no token in it, no redirect taken from the query. Tells the
 * window that opened it (the Connect button) how it went, then closes.
 */
function callbackPage(opts: {
  locale: CallbackLocale;
  ok: boolean;
  serverId: number | null;
  title: string;
  body: string;
}): string {
  const copy = CALLBACK_COPY[opts.locale];
  const base = connectorBaseUrl() ?? '';
  const targetOrigin = base ? new URL(base).origin : '*';
  const message = JSON.stringify({ type: MCP_CONNECT_MESSAGE_TYPE, server_id: opts.serverId, ok: opts.ok });
  return `<!doctype html>
<html lang="${opts.locale === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f5; color: #1f2a24; }
  main { max-width: 420px; padding: 32px; text-align: center; }
  .mark { font-size: 40px; margin-bottom: 12px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { font-size: 14px; line-height: 1.6; color: #4b5a51; margin: 0 0 20px; word-break: break-word; }
  a { color: #0f766e; font-size: 14px; }
  @media (prefers-color-scheme: dark) { body { background: #111714; color: #e7efe9; } p { color: #a7b8ad; } a { color: #5eead4; } }
</style>
</head>
<body>
<main data-testid="connector-callback" data-ok="${opts.ok ? 'true' : 'false'}">
  <div class="mark">${opts.ok ? '✓' : '!'}</div>
  <h1>${escapeHtml(opts.title)}</h1>
  <p>${escapeHtml(opts.body)}</p>
  <a href="${escapeHtml(`${base}/#/settings/connectors`)}">${escapeHtml(copy.back)}</a>
</main>
<script>
  (function () {
    try {
      if (window.opener) {
        window.opener.postMessage(${message}, ${JSON.stringify(targetOrigin)});
        setTimeout(function () { window.close(); }, ${opts.ok ? 1200 : 4000});
      }
    } catch (e) {}
  })();
</script>
</body>
</html>`;
}

function localeOf(raw: string | null | undefined): CallbackLocale {
  return raw === 'zh' ? 'zh' : 'en';
}

/** Before the member is known (a refused or broken callback), the browser's language decides. */
function browserLocale(c: Context<AppEnv>): CallbackLocale {
  return c.req.header('accept-language')?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

const connectorRoutes = new Hono<AppEnv>()
  // ── Public: the provider sends the member's browser back here ──
  .get('/oauth/callback', async (c) => {
    const db = getDb();
    const providerError = c.req.query('error');
    if (providerError) {
      // The member declined on the consent page, or the provider refused.
      const detail = c.req.query('error_description');
      const locale = browserLocale(c);
      return c.html(
        callbackPage({
          locale,
          ok: false,
          serverId: null,
          title: CALLBACK_COPY[locale].failTitle,
          body: `The provider answered "${providerError}"${detail ? `: ${detail}` : ''}.`.slice(0, 400),
        }),
        400,
      );
    }
    try {
      const { server, userId } = await finishConnectorSignIn(db, {
        state: c.req.query('state'),
        code: c.req.query('code'),
      });
      const user = await db.users.getById(userId);
      const locale = localeOf(user?.locale);
      // First connection to a server nobody has listed yet: use it to list the
      // tools now, so the connector is usable the moment this window closes.
      await discoverIfEmpty(db, server.id, userId).catch((err) =>
        logger.info('[connectors] discovery after sign-in failed', { error: toErrorMessage(err) }),
      );
      logger.info('[connectors] member connected', { server: server.slug, userId });
      return c.html(
        callbackPage({
          locale,
          ok: true,
          serverId: server.id,
          title: CALLBACK_COPY[locale].okTitle(server.name),
          body: CALLBACK_COPY[locale].okBody,
        }),
      );
    } catch (err) {
      const message = err instanceof ConnectorSignInError ? err.message : 'Something went wrong — start again.';
      if (!(err instanceof ConnectorSignInError)) {
        logger.warn('[connectors] sign-in callback failed', { error: toErrorMessage(err) });
      }
      const locale = browserLocale(c);
      return c.html(
        callbackPage({ locale, ok: false, serverId: null, title: CALLBACK_COPY[locale].failTitle, body: message }),
        400,
      );
    }
  })

  // ── Public: the instance's client-id metadata document (SEP-991) ──
  .get('/oauth/client-metadata.json', (c) => {
    const url = connectorClientMetadataUrl();
    const redirectUri = connectorRedirectUri();
    if (!url || !redirectUri) return c.json({ error: 'Not available: PUBLIC_BASE_URL is not an https URL' }, 404);
    c.header('Cache-Control', 'public, max-age=3600');
    return c.json({ client_id: url, ...connectorClientMetadata(redirectUri) });
  })

  // ── Member routes ──
  .get('/', requireInternal(), async (c) => {
    const user = getAuthUser(c);
    if (!(await mayUseConnectors(user))) return c.json({ enabled: false, connectors: [] as McpConnectorView[] });
    return c.json({ enabled: true, connectors: await connectorViews(getDb(), user.id) });
  })

  .post('/:id/authorize', requireInternal(), async (c) => {
    const loaded = await loadForMember(c);
    if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status);
    const { user, row } = loaded;
    if (row.auth_mode !== 'oauth') return c.json({ error: `${row.name} does not use a sign-in.` }, 400);
    if (!isEncryptionConfigured()) {
      return c.json({ error: 'PROVIDER_TOKEN_ENCRYPTION_KEY is not configured on this server.' }, 500);
    }
    const redirectUri = connectorRedirectUri(c.req.url);
    if (!redirectUri) return c.json({ error: 'Set PUBLIC_BASE_URL so the provider can send you back.' }, 500);
    try {
      const url = await beginConnectorSignIn(getDb(), row, user.id, redirectUri);
      return c.json({ url });
    } catch (err) {
      const message =
        err instanceof ConnectorSignInError ? err.message : `Could not start the sign-in: ${toErrorMessage(err)}`;
      logger.warn('[connectors] could not start a sign-in', { server: row.slug, error: message });
      return c.json({ error: message }, 502);
    }
  })

  .put('/:id/key', requireInternal(), async (c) => {
    const loaded = await loadForMember(c);
    if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status);
    const { user, row } = loaded;
    if (row.auth_mode !== 'per_user') return c.json({ error: `${row.name} does not take a personal key.` }, 400);
    if (!isEncryptionConfigured()) {
      return c.json({ error: 'PROVIDER_TOKEN_ENCRYPTION_KEY is not configured on this server.' }, 500);
    }
    const parsed = keySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'key is required' }, 400);
    const key = parsed.data.key;

    // Prove the key works before keeping it: a typo should fail here, not in
    // the middle of a conversation.
    const target = { ...placeCredential(row, key), transport: row.transport };
    let tools;
    try {
      tools = await discoverMcpTools(target);
    } catch (err) {
      const reason = (await explainFailedConnect(target)) ?? describeMcpError(err);
      return c.json({ error: `${row.name} did not accept this key: ${redactSecrets(reason, [key])}` }, 400);
    }
    const db = getDb();
    await db.mcpServers.saveConnection(user.id, row.id, {
      credential: sealMemberCredential(row.id, user.id, key),
      metadata: { connected_via: 'key' },
    });
    if (!Array.isArray(row.tools) || row.tools.length === 0) {
      await db.mcpServers.recordRefresh(row.id, { ok: true, tools });
      await refreshMcpDirectory(db);
    }
    logger.info('[connectors] member stored a key', { server: row.slug, userId: user.id });
    const view = (await connectorViews(db, user.id)).find((v) => v.id === row.id) ?? null;
    return c.json({ ok: true, connector: view });
  })

  .post('/:id/test', requireInternal(), async (c) => {
    const loaded = await loadForMember(c);
    if (!loaded.ok) return c.json({ error: loaded.error }, loaded.status);
    const { user, row } = loaded;
    const db = getDb();
    const resolved = await resolveConnectTarget(db, row, user.id);
    if (!resolved.ok) return c.json({ ok: false, status: resolved.reason, error: resolved.error });
    try {
      const list = () => discoverMcpTools(resolved.target);
      const tools = resolved.target.authProvider ? await withConnectionLock(row.id, user.id, list) : await list();
      return c.json({ ok: true, tool_count: tools.length, error: null });
    } catch (err) {
      const provider = resolved.target.authProvider;
      if (provider instanceof ConnectorOAuthProvider && /401|unauthori[sz]ed|reconnect/i.test(toErrorMessage(err))) {
        await provider.expireUsedSignIn();
      }
      return c.json({ ok: false, status: 'error', error: redactSecrets(describeMcpError(err), resolved.secrets) });
    }
  })

  .delete('/:id', requireInternal(), async (c) => {
    const user = getAuthUser(c);
    const id = parseId(c.req.param('id') ?? '');
    if (id === null) return c.json({ error: 'Invalid connector id' }, 400);
    const db = getDb();
    // Disconnecting is always allowed — even from a connector since disabled or
    // a grant since revoked: a member must be able to take their key back.
    const connection = await db.mcpServers.getConnection(user.id, id);
    if (!connection) return c.json({ ok: true, removed: false });
    const row = await db.mcpServers.getById(id);
    if (row?.auth_mode === 'oauth') await revokeConnectorSignIn(row, user.id, connection);
    await db.mcpServers.deleteConnection(user.id, id);
    logger.info('[connectors] member disconnected', { serverId: id, userId: user.id });
    return c.json({ ok: true, removed: true });
  });

export default connectorRoutes;
