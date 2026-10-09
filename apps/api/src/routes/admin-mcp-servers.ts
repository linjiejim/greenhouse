/**
 * External MCP servers ("connectors") — /api/admin/mcp-servers (super only, guarded at the mount)
 *
 * GET    /api/admin/mcp-servers                    — every installed server (credentials reduced to has_*)
 * POST   /api/admin/mcp-servers                    — install one and discover its tools right away
 * PUT    /api/admin/mcp-servers/:id                — edit; a changed address or auth mode drops every
 *                                                    member's connection and re-runs discovery
 * DELETE /api/admin/mcp-servers/:id                — remove (members' connections go with it)
 * POST   /api/admin/mcp-servers/:id/refresh        — reconnect and re-list the server's tools
 * POST   /api/admin/mcp-servers/probe              — what an address asks for (none / sign-in) before installing
 * GET    /api/admin/mcp-servers/catalog            — the official connector catalog (`connectors/*.json`)
 * POST   /api/admin/mcp-servers/catalog/install    — install a catalog entry as vetted
 * GET    /api/admin/mcp-servers/registry?search=   — search the official MCP Registry (remote servers only)
 *
 * The CLIENT side of MCP (spec 20261009 D5, extended by spec
 * 20261009-mcp-connectors): members granted `mcp_call` reach these servers'
 * tools from chat and Bots. A server that cannot be reached is still saved —
 * it may simply be down — and `last_error` says why; it offers no tools until a
 * refresh succeeds. A `per_user` / `oauth` server is listed with the ACTING
 * admin's own connection (D6). Every write reloads the in-memory directory the
 * chat turn reads.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { getDb, type McpServerRow } from '@greenhouse/db';
import {
  isPersonalAuthMode,
  MCP_AUTH_MODES,
  MCP_SERVER_TRANSPORTS,
  validateMcpAuthConfig,
  validateMcpServerInput,
  type McpAuthMode,
} from '@greenhouse/types/mcp-servers';
import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import { encryptToken, isEncryptionConfigured } from '../auth/crypto.js';
import { refreshMcpDirectory, refreshServerTools, toMcpServerView } from '../mcp-client/directory.js';
import { manualClient, readStoredClient } from '../mcp-client/oauth.js';
import { findCatalogEntry, listCatalog, probeServerAuth, searchOfficialRegistry } from '../mcp-client/catalog.js';

const fields = {
  name: z.string().trim(),
  description: z.string().trim().nullish(),
  url: z.string().trim(),
  transport: z.enum(MCP_SERVER_TRANSPORTS),
  auth_mode: z.enum(MCP_AUTH_MODES),
  auth_header: z.string().trim().nullish(),
  auth_query_param: z.string().trim().nullish(),
  // Not trimmed: "Bearer " ends in the space that separates it from the value.
  auth_value_prefix: z.string().max(64).nullish(),
  // Trimmed: a pasted token routinely carries a trailing newline, and no HTTP
  // header value legitimately ends in one.
  auth_value: z.string().trim().max(4096),
  credential_help: z.string().trim().nullish(),
  credential_url: z.string().trim().nullish(),
  oauth_scope: z.string().trim().nullish(),
  oauth_client_id: z.string().trim().nullish(),
  oauth_client_secret: z.string().trim().max(4096),
  enabled: z.boolean(),
  allowed_tools: z.array(z.string().trim().min(1)).nullish(),
  read_only_tools: z.array(z.string().trim().min(1)).nullish(),
};

const createSchema = z.object({ slug: z.string().trim(), ...fields }).partial({
  description: true,
  transport: true,
  auth_mode: true,
  auth_header: true,
  auth_query_param: true,
  auth_value_prefix: true,
  auth_value: true,
  credential_help: true,
  credential_url: true,
  oauth_scope: true,
  oauth_client_id: true,
  oauth_client_secret: true,
  enabled: true,
  allowed_tools: true,
  read_only_tools: true,
});
const updateSchema = z.object(fields).partial();
const installSchema = z.object({ id: z.string().trim().min(1), slug: z.string().trim().optional() });
const probeSchema = z.object({ url: z.string().trim(), transport: z.enum(MCP_SERVER_TRANSPORTS).optional() });

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** '' clears the stored credential, undefined keeps it, anything else replaces it. */
function credentialUpdate(value: string | undefined): { auth_value_encrypted?: string | null } {
  if (value === undefined) return {};
  return { auth_value_encrypted: value === '' ? null : encryptToken(value) };
}

/** Empty strings from a form mean "not set". */
function orNull(value: string | null | undefined): string | null | undefined {
  return value === undefined ? undefined : value || null;
}

/** Run discovery as the acting admin and answer with the row as it stands afterwards. */
async function withDiscovery(row: McpServerRow, actorUserId: string) {
  const db = getDb();
  const refreshed = await refreshServerTools(db, row, actorUserId);
  const counts = await db.mcpServers.connectionCounts();
  return {
    server: toMcpServerView(refreshed.row, counts.get(row.id) ?? 0),
    refresh: { ok: refreshed.ok, error: refreshed.error ?? null },
  };
}

async function viewOf(row: McpServerRow) {
  const counts = await getDb().mcpServers.connectionCounts();
  return toMcpServerView(row, counts.get(row.id) ?? 0);
}

const adminMcpServerRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    getAuthUser(c);
    const db = getDb();
    const [rows, counts] = await Promise.all([db.mcpServers.list(), db.mcpServers.connectionCounts()]);
    return c.json({ servers: rows.map((row) => toMcpServerView(row, counts.get(row.id) ?? 0)) });
  })

  .get('/catalog', async (c) => {
    getAuthUser(c);
    const installed = new Map(
      (await getDb().mcpServers.list()).filter((row) => row.catalog_id).map((row) => [row.catalog_id!, row.slug]),
    );
    return c.json({
      entries: listCatalog().map((entry) => ({ ...entry, installed_slug: installed.get(entry.id) ?? null })),
    });
  })

  .get('/registry', async (c) => {
    getAuthUser(c);
    const search = (c.req.query('search') ?? '').trim().slice(0, 100);
    try {
      return c.json({ results: await searchOfficialRegistry(search), error: null });
    } catch (err) {
      return c.json({ results: [], error: err instanceof Error ? err.message : String(err) });
    }
  })

  .post('/probe', async (c) => {
    getAuthUser(c);
    const parsed = probeSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'url is required' }, 400);
    const problem = validateMcpServerInput({ url: parsed.data.url }, { partial: true });
    if (problem) return c.json({ error: problem }, 400);
    return c.json(await probeServerAuth(parsed.data.url, parsed.data.transport ?? 'streamable_http'));
  })

  .post('/catalog/install', async (c) => {
    const user = getAuthUser(c);
    const parsed = installSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'id is required' }, 400);
    const entry = findCatalogEntry(parsed.data.id);
    if (!entry) return c.json({ error: `No catalog entry "${parsed.data.id}"` }, 404);
    const slug = parsed.data.slug || entry.slug;
    const problem = validateMcpServerInput({ slug }, { partial: true });
    if (problem) return c.json({ error: problem }, 400);
    if (isPersonalAuthMode(entry.auth.mode) && !isEncryptionConfigured()) {
      return c.json({ error: 'PROVIDER_TOKEN_ENCRYPTION_KEY is not configured on this server.' }, 500);
    }
    // Members read the key help in the team's language — the installing admin's.
    const zh = (await getDb().users.getById(user.id))?.locale === 'zh';
    const help = (zh ? entry.auth.help_zh : undefined) ?? entry.auth.help ?? null;
    const row = await getDb().mcpServers.create({
      slug,
      name: entry.title,
      description: entry.description,
      url: entry.url,
      transport: entry.transport,
      auth_mode: entry.auth.mode,
      auth_header: entry.auth.header ?? null,
      auth_query_param: entry.auth.query_param ?? null,
      auth_value_prefix: entry.auth.prefix ?? null,
      credential_help: help,
      credential_url: entry.auth.help_url ?? null,
      oauth_scope: entry.auth.scope ?? null,
      read_only_tools: entry.read_only_tools.length > 0 ? entry.read_only_tools : null,
      catalog_id: entry.id,
      created_by: user.id,
    });
    if (!row) return c.json({ error: `A server with id "${slug}" already exists — pick another id.` }, 409);
    return c.json(await withDiscovery(row, user.id), 201);
  })

  .post('/', async (c) => {
    const user = getAuthUser(c);
    const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: `Invalid request: ${parsed.error.issues[0]?.message ?? 'bad body'}` }, 400);
    }
    const input = parsed.data;
    const problem = validateMcpServerInput(input);
    if (problem) return c.json({ error: problem }, 400);
    // Before auth modes, a stored credential simply meant "send it": keep that reading.
    const authMode: McpAuthMode = input.auth_mode ?? (input.auth_value ? 'shared' : 'none');
    const authQueryParam = orNull(input.auth_query_param) ?? null;
    // A credential with nowhere said to go goes in `Authorization`, as it always did.
    const authHeader =
      orNull(input.auth_header) ??
      ((authMode === 'shared' || authMode === 'per_user') && !authQueryParam ? 'Authorization' : null);
    const configProblem = validateMcpAuthConfig({
      auth_mode: authMode,
      auth_header: authHeader,
      auth_query_param: authQueryParam,
      has_shared_credential: Boolean(input.auth_value),
    });
    if (configProblem) return c.json({ error: configProblem }, 400);
    if ((input.auth_value || input.oauth_client_secret || isPersonalAuthMode(authMode)) && !isEncryptionConfigured()) {
      return c.json({ error: 'PROVIDER_TOKEN_ENCRYPTION_KEY is not configured on this server.' }, 500);
    }

    const db = getDb();
    let row = await db.mcpServers.create({
      slug: input.slug,
      name: input.name,
      description: input.description || null,
      url: input.url,
      ...(input.transport ? { transport: input.transport } : {}),
      auth_mode: authMode,
      auth_header: authHeader,
      auth_query_param: authQueryParam,
      auth_value_prefix: input.auth_value_prefix || null,
      ...credentialUpdate(input.auth_value || undefined),
      credential_help: input.credential_help || null,
      credential_url: input.credential_url || null,
      oauth_scope: input.oauth_scope || null,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      allowed_tools: input.allowed_tools ?? null,
      read_only_tools: input.read_only_tools ?? null,
      created_by: user.id,
    });
    if (!row) return c.json({ error: `A server with id "${input.slug}" already exists — pick another id.` }, 409);
    if (input.oauth_client_id) {
      const sealed = manualClient(row.id, input.oauth_client_id, input.oauth_client_secret || undefined);
      await db.mcpServers.setOAuthClient(row.id, sealed);
      row = { ...row, oauth_client_encrypted: sealed };
    }
    return c.json(await withDiscovery(row, user.id), 201);
  })

  .put('/:id', async (c) => {
    const user = getAuthUser(c);
    const id = parseId(c.req.param('id'));
    if (id === null) return c.json({ error: 'Invalid server id' }, 400);
    const db = getDb();
    const existing = await db.mcpServers.getById(id);
    if (!existing) return c.json({ error: `MCP server ${id} not found` }, 404);

    const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: `Invalid request: ${parsed.error.issues[0]?.message ?? 'bad body'}` }, 400);
    }
    const input = parsed.data;
    const problem = validateMcpServerInput(input, { partial: true });
    if (problem) return c.json({ error: problem }, 400);

    const authMode = input.auth_mode ?? existing.auth_mode;
    const authHeader = input.auth_header !== undefined ? orNull(input.auth_header)! : existing.auth_header;
    const authQueryParam =
      input.auth_query_param !== undefined ? orNull(input.auth_query_param)! : existing.auth_query_param;
    // Switching away from "shared" drops the shared credential with it.
    const clearsShared = authMode !== 'shared' && existing.auth_value_encrypted && input.auth_value === undefined;
    const hasShared =
      input.auth_value !== undefined
        ? input.auth_value !== ''
        : Boolean(existing.auth_value_encrypted) && !clearsShared;
    const configProblem = validateMcpAuthConfig({
      auth_mode: authMode,
      auth_header: authHeader,
      auth_query_param: authQueryParam,
      has_shared_credential: hasShared,
    });
    if (configProblem) return c.json({ error: configProblem }, 400);
    if ((input.auth_value || input.oauth_client_secret || isPersonalAuthMode(authMode)) && !isEncryptionConfigured()) {
      return c.json({ error: 'PROVIDER_TOKEN_ENCRYPTION_KEY is not configured on this server.' }, 500);
    }

    // A manual OAuth client: '' / null clears it, a new id replaces it (keeping
    // the stored secret when the same client is re-saved without one).
    let oauthClient: { oauth_client_encrypted?: string | null } = {};
    if (input.oauth_client_id !== undefined) {
      if (!input.oauth_client_id) {
        oauthClient = readStoredClient(existing)?.source === 'manual' ? { oauth_client_encrypted: null } : {};
      } else {
        const stored = readStoredClient(existing);
        const secret =
          input.oauth_client_secret !== undefined
            ? input.oauth_client_secret || undefined
            : stored?.source === 'manual' && stored.client_id === input.oauth_client_id
              ? stored.client_secret
              : undefined;
        oauthClient = { oauth_client_encrypted: manualClient(id, input.oauth_client_id, secret) };
      }
    }

    // Where the server is or whose credential it takes changed: every member's
    // connection was made for the old one (spec D1).
    const resetConnections = (input.url !== undefined && input.url !== existing.url) || authMode !== existing.auth_mode;

    const updated = await db.mcpServers.update(
      id,
      {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description || null } : {}),
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.transport !== undefined ? { transport: input.transport } : {}),
        ...(input.auth_mode !== undefined ? { auth_mode: input.auth_mode } : {}),
        ...(input.auth_header !== undefined ? { auth_header: authHeader } : {}),
        ...(input.auth_query_param !== undefined ? { auth_query_param: authQueryParam } : {}),
        ...(input.auth_value_prefix !== undefined ? { auth_value_prefix: input.auth_value_prefix || null } : {}),
        ...(clearsShared ? { auth_value_encrypted: null } : credentialUpdate(input.auth_value)),
        ...(input.credential_help !== undefined ? { credential_help: input.credential_help || null } : {}),
        ...(input.credential_url !== undefined ? { credential_url: input.credential_url || null } : {}),
        ...(input.oauth_scope !== undefined ? { oauth_scope: input.oauth_scope || null } : {}),
        ...oauthClient,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.allowed_tools !== undefined ? { allowed_tools: input.allowed_tools ?? null } : {}),
        ...(input.read_only_tools !== undefined ? { read_only_tools: input.read_only_tools ?? null } : {}),
      },
      { resetConnections },
    );
    if (!updated) return c.json({ error: `MCP server ${id} not found` }, 404);

    // What the server offers may have changed with where it is or how we
    // authenticate, so ask it again rather than keep a stale tool list.
    const reconnect =
      resetConnections ||
      (input.transport !== undefined && input.transport !== existing.transport) ||
      input.auth_value !== undefined ||
      (input.auth_header !== undefined && authHeader !== existing.auth_header) ||
      (input.auth_query_param !== undefined && authQueryParam !== existing.auth_query_param);
    if (reconnect && updated.enabled) return c.json(await withDiscovery(updated, user.id));

    await refreshMcpDirectory();
    return c.json({ server: await viewOf(updated), refresh: null });
  })

  .delete('/:id', async (c) => {
    getAuthUser(c);
    const id = parseId(c.req.param('id'));
    if (id === null) return c.json({ error: 'Invalid server id' }, 400);
    const removed = await getDb().mcpServers.remove(id);
    if (!removed) return c.json({ error: `MCP server ${id} not found` }, 404);
    await refreshMcpDirectory();
    return c.json({ ok: true });
  })

  .post('/:id/refresh', async (c) => {
    const user = getAuthUser(c);
    const id = parseId(c.req.param('id'));
    if (id === null) return c.json({ error: 'Invalid server id' }, 400);
    const row = await getDb().mcpServers.getById(id);
    if (!row) return c.json({ error: `MCP server ${id} not found` }, 404);
    return c.json(await withDiscovery(row, user.id));
  });

export default adminMcpServerRoutes;
