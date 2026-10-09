/**
 * The MCP server directory — what `mcp_call` can see, kept in memory.
 *
 * The chat route builds its tools synchronously on every turn, and the
 * `mcp_call` description lists the connected servers and their tools. So the
 * enabled servers (with the tools each advertised at its last refresh, minus
 * anything outside its allow-list) live in a snapshot here: loaded at boot and
 * reloaded after every admin write. A turn never waits on a remote server.
 *
 * Single-process, like the workspace-config overlay: a multi-node deployment
 * would need a restart (or a shared invalidation) to see an admin's change.
 */

import { getDb, type DatabaseProvider, type McpServerRow } from '@greenhouse/db';
import type { McpRemoteTool, McpServerView } from '@greenhouse/types/mcp-servers';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { decryptToken } from '../auth/crypto.js';
import { describeMcpError, discoverMcpTools, type McpConnectTarget } from './client.js';

export interface McpDirectoryServer {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  /** Only the tools members may call (the allow-list applied). */
  tools: McpRemoteTool[];
}

let snapshot: readonly McpDirectoryServer[] = [];

/** The allow-list applied to what the server advertised. */
export function callableTools(row: Pick<McpServerRow, 'tools' | 'allowed_tools'>): McpRemoteTool[] {
  const advertised = Array.isArray(row.tools) ? row.tools : [];
  if (!row.allowed_tools) return advertised;
  const allowed = new Set(row.allowed_tools);
  return advertised.filter((tool) => allowed.has(tool.name));
}

/** Reload the snapshot from the database. Never throws — a failure keeps the old one. */
export async function refreshMcpDirectory(db: DatabaseProvider = getDb()): Promise<void> {
  try {
    const rows = await db.mcpServers.listEnabled();
    snapshot = rows
      .map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        tools: callableTools(row),
      }))
      // A server with nothing callable is not a capability yet (never refreshed,
      // or its allow-list matches nothing) — offering it would be a false promise.
      .filter((server) => server.tools.length > 0);
  } catch (err) {
    logger.warn('[mcp-client] could not load the MCP server directory', { error: toErrorMessage(err) });
  }
}

/** The enabled servers with something callable, as of the last refresh. */
export function getMcpDirectory(): readonly McpDirectoryServer[] {
  return snapshot;
}

/** Test seam. */
export function _setMcpDirectory(servers: readonly McpDirectoryServer[]): void {
  snapshot = servers;
}

/** Decrypt the stored credential into something the client can connect with. */
export function connectTarget(row: McpServerRow): McpConnectTarget {
  return {
    url: row.url,
    transport: row.transport,
    authHeader: row.auth_header,
    authValue: row.auth_value_encrypted ? decryptToken(row.auth_value_encrypted) : null,
  };
}

/**
 * Connect, list the server's tools and record the outcome on the row. The
 * previous tool list survives a failed refresh (a flaky server keeps working
 * from its last known tools) — `last_error` says what went wrong.
 */
export async function refreshServerTools(
  db: DatabaseProvider,
  row: McpServerRow,
): Promise<{ row: McpServerRow; ok: boolean; error?: string }> {
  let outcome: { ok: true; tools: McpRemoteTool[] } | { ok: false; error: string };
  try {
    outcome = { ok: true, tools: await discoverMcpTools(connectTarget(row)) };
  } catch (err) {
    outcome = { ok: false, error: describeMcpError(err) };
  }
  const updated = (await db.mcpServers.recordRefresh(row.id, outcome)) ?? row;
  await refreshMcpDirectory(db);
  return outcome.ok ? { row: updated, ok: true } : { row: updated, ok: false, error: outcome.error };
}

/** The admin view of a row — the credential reduced to "is one stored". */
export function toMcpServerView(row: McpServerRow): McpServerView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    url: row.url,
    transport: row.transport,
    auth_header: row.auth_header,
    has_auth_value: Boolean(row.auth_value_encrypted),
    enabled: row.enabled,
    allowed_tools: row.allowed_tools ?? null,
    tools: Array.isArray(row.tools) ? row.tools : [],
    tools_refreshed_at: row.tools_refreshed_at,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
