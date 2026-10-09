/**
 * External MCP servers — /api/admin/mcp-servers (super only, guarded at the mount)
 *
 * GET    /api/admin/mcp-servers              — every registered server (credential reduced to has_auth_value)
 * POST   /api/admin/mcp-servers              — register one and discover its tools right away
 * PUT    /api/admin/mcp-servers/:id          — edit; a changed url/transport/credential re-runs discovery
 * DELETE /api/admin/mcp-servers/:id          — remove
 * POST   /api/admin/mcp-servers/:id/refresh  — reconnect and re-list the server's tools
 *
 * The CLIENT side of MCP (spec 20261009 D5): members granted `mcp_call` reach
 * these servers' tools from chat. A server that cannot be reached is still
 * saved — it may simply be down — and `last_error` says why; it offers no tools
 * until a refresh succeeds. Every write reloads the in-memory directory the
 * chat turn reads.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { getDb, type McpServerRow } from '@greenhouse/db';
import { MCP_SERVER_TRANSPORTS, validateMcpServerInput } from '@greenhouse/types/mcp-servers';
import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import { encryptToken, isEncryptionConfigured } from '../auth/crypto.js';
import { refreshMcpDirectory, refreshServerTools, toMcpServerView } from '../mcp-client/directory.js';

const fields = {
  name: z.string().trim(),
  description: z.string().trim().nullish(),
  url: z.string().trim(),
  transport: z.enum(MCP_SERVER_TRANSPORTS),
  auth_header: z.string().trim().nullish(),
  // Trimmed: a pasted token routinely carries a trailing newline, and no HTTP
  // header value legitimately ends in one.
  auth_value: z.string().trim().max(4096),
  enabled: z.boolean(),
  allowed_tools: z.array(z.string().trim().min(1)).nullish(),
};

const createSchema = z.object({ slug: z.string().trim(), ...fields }).partial({
  description: true,
  transport: true,
  auth_header: true,
  auth_value: true,
  enabled: true,
  allowed_tools: true,
});
const updateSchema = z.object(fields).partial();

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** '' clears the stored credential, undefined keeps it, anything else replaces it. */
function credentialUpdate(value: string | undefined): { auth_value_encrypted?: string | null } {
  if (value === undefined) return {};
  return { auth_value_encrypted: value === '' ? null : encryptToken(value) };
}

/** Run discovery and answer with the row as it stands afterwards. */
async function withDiscovery(row: McpServerRow) {
  const refreshed = await refreshServerTools(getDb(), row);
  return { server: toMcpServerView(refreshed.row), refresh: { ok: refreshed.ok, error: refreshed.error ?? null } };
}

const adminMcpServerRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    getAuthUser(c);
    const rows = await getDb().mcpServers.list();
    return c.json({ servers: rows.map(toMcpServerView) });
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
    if (input.auth_value && !isEncryptionConfigured()) {
      return c.json({ error: 'PROVIDER_TOKEN_ENCRYPTION_KEY is not configured on this server.' }, 500);
    }

    const row = await getDb().mcpServers.create({
      slug: input.slug,
      name: input.name,
      description: input.description || null,
      url: input.url,
      ...(input.transport ? { transport: input.transport } : {}),
      auth_header: input.auth_value ? input.auth_header || 'Authorization' : (input.auth_header ?? null),
      ...credentialUpdate(input.auth_value || undefined),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      allowed_tools: input.allowed_tools ?? null,
      created_by: user.id,
    });
    if (!row) return c.json({ error: `A server with id "${input.slug}" already exists — pick another id.` }, 409);
    return c.json(await withDiscovery(row), 201);
  })

  .put('/:id', async (c) => {
    getAuthUser(c);
    const id = parseId(c.req.param('id'));
    if (id === null) return c.json({ error: 'Invalid server id' }, 400);
    const existing = await getDb().mcpServers.getById(id);
    if (!existing) return c.json({ error: `MCP server ${id} not found` }, 404);

    const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: `Invalid request: ${parsed.error.issues[0]?.message ?? 'bad body'}` }, 400);
    }
    const input = parsed.data;
    const problem = validateMcpServerInput(input, { partial: true });
    if (problem) return c.json({ error: problem }, 400);
    if (input.auth_value && !isEncryptionConfigured()) {
      return c.json({ error: 'PROVIDER_TOKEN_ENCRYPTION_KEY is not configured on this server.' }, 500);
    }

    const updated = await getDb().mcpServers.update(id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.transport !== undefined ? { transport: input.transport } : {}),
      ...(input.auth_header !== undefined ? { auth_header: input.auth_header || null } : {}),
      ...credentialUpdate(input.auth_value),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.allowed_tools !== undefined ? { allowed_tools: input.allowed_tools ?? null } : {}),
    });
    if (!updated) return c.json({ error: `MCP server ${id} not found` }, 404);

    // Where the server is or how we authenticate changed: what it offers may
    // have changed too, so ask it again rather than keep a stale tool list.
    const reconnect =
      (input.url !== undefined && input.url !== existing.url) ||
      (input.transport !== undefined && input.transport !== existing.transport) ||
      input.auth_value !== undefined ||
      (input.auth_header !== undefined && (input.auth_header || null) !== existing.auth_header);
    if (reconnect && updated.enabled) return c.json(await withDiscovery(updated));

    await refreshMcpDirectory();
    return c.json({ server: toMcpServerView(updated), refresh: null });
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
    getAuthUser(c);
    const id = parseId(c.req.param('id'));
    if (id === null) return c.json({ error: 'Invalid server id' }, 400);
    const row = await getDb().mcpServers.getById(id);
    if (!row) return c.json({ error: `MCP server ${id} not found` }, 404);
    return c.json(await withDiscovery(row));
  });

export default adminMcpServerRoutes;
