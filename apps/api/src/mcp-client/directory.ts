/**
 * The MCP server directory — what `mcp_call` can see, kept in memory.
 *
 * The chat route builds its tools synchronously on every turn, and the
 * `mcp_call` description lists the connected servers and their tools. So the
 * enabled servers (with the tools each advertised at its last refresh, minus
 * anything outside its allow-list) live in a snapshot here: loaded at boot and
 * reloaded after every admin write. A turn never waits on a remote server.
 *
 * The snapshot is the same for every member: whether THEY have connected a
 * per_user / oauth server is read when a call needs it, so the description
 * (part of the cached prompt prefix) does not change with anyone's connections
 * (spec 20261009-mcp-connectors D7).
 *
 * Single-process, like the workspace-config overlay: a multi-node deployment
 * would need a restart (or a shared invalidation) to see an admin's change.
 */

import { getDb, type DatabaseProvider, type McpServerRow } from '@greenhouse/db';
import {
  isEffectivelyReadOnly,
  isPersonalAuthMode,
  type McpAuthMode,
  type McpRemoteTool,
  type McpServerView,
} from '@greenhouse/types/mcp-servers';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { describeMcpError, discoverMcpTools, explainFailedConnect } from './client.js';
import { redactSecrets, resolveConnectTarget } from './credentials.js';
import { readStoredClient, withConnectionLock } from './oauth.js';

export interface McpDirectoryServer {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  auth_mode: McpAuthMode;
  /** Only the tools members may call (the allow-list applied), `read_only` = effectively read-only. */
  tools: McpRemoteTool[];
}

let snapshot: readonly McpDirectoryServer[] = [];

/** The allow-list applied to what the server advertised, read-only as vouched for (spec D10). */
export function callableTools(row: Pick<McpServerRow, 'tools' | 'allowed_tools' | 'read_only_tools'>): McpRemoteTool[] {
  const advertised = Array.isArray(row.tools) ? row.tools : [];
  const allowed = row.allowed_tools ? new Set(row.allowed_tools) : null;
  return advertised
    .filter((tool) => !allowed || allowed.has(tool.name))
    .map((tool) => ({ ...tool, read_only: isEffectivelyReadOnly(tool, row.read_only_tools) }));
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
        auth_mode: row.auth_mode,
        tools: callableTools(row),
      }))
      // A server with nothing callable is not a capability yet (never refreshed,
      // or its allow-list matches nothing) — offering it would be a false promise.
      // Except one that works with each member's own account and that nobody has
      // connected yet: its tools are unknown until someone does, and what it
      // offers meanwhile is real — calling it shows the member a Connect button.
      .filter((server) => server.tools.length > 0 || isPersonalAuthMode(server.auth_mode));
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

export type RefreshOutcome = { row: McpServerRow; ok: boolean; error?: string };

/**
 * Connect as `actorUserId`, list the server's tools and record the outcome on
 * the row. The previous tool list survives a failed refresh (a flaky server
 * keeps working from its last known tools) — `last_error` says what went wrong.
 *
 * A per_user / oauth server is listed with the ACTOR's own connection (spec
 * D6). An actor who has not connected gets the reason back, but nothing is
 * recorded: that is their state, not the server's.
 */
export async function refreshServerTools(
  db: DatabaseProvider,
  row: McpServerRow,
  actorUserId: string,
): Promise<RefreshOutcome> {
  const resolved = await resolveConnectTarget(db, row, actorUserId);
  if (!resolved.ok) {
    // Nothing to list with yet, but the server itself is new or changed: a per-member one
    // belongs in the directory now (a call shows each member a Connect button), not only
    // after the next restart.
    await refreshMcpDirectory(db);
    return {
      row,
      ok: false,
      error:
        row.auth_mode === 'oauth'
          ? 'Connect your own account to this server first — its tools are listed with your sign-in.'
          : 'Add your own key for this server first — its tools are listed with your key.',
    };
  }
  let outcome: { ok: true; tools: McpRemoteTool[] } | { ok: false; error: string };
  try {
    const list = () => discoverMcpTools(resolved.target);
    const tools = resolved.target.authProvider ? await withConnectionLock(row.id, actorUserId, list) : await list();
    outcome = { ok: true, tools };
  } catch (err) {
    const better = resolved.target.authProvider ? null : await explainFailedConnect(resolved.target);
    outcome = { ok: false, error: redactSecrets(better ?? describeMcpError(err), resolved.secrets) };
  }
  const updated = (await db.mcpServers.recordRefresh(row.id, outcome)) ?? row;
  await refreshMcpDirectory(db);
  return outcome.ok ? { row: updated, ok: true } : { row: updated, ok: false, error: outcome.error };
}

/**
 * After a member connects: if nobody has listed this server's tools yet, use
 * the fresh connection to do it (spec D6). Failures only log — the connection
 * itself succeeded.
 */
export async function discoverIfEmpty(db: DatabaseProvider, serverId: number, userId: string): Promise<void> {
  const row = await db.mcpServers.getById(serverId);
  if (!row || (Array.isArray(row.tools) && row.tools.length > 0)) return;
  const result = await refreshServerTools(db, row, userId);
  if (!result.ok) {
    logger.info('[mcp-client] first discovery after a connection failed', { server: row.slug, error: result.error });
  }
}

/** The admin view of a row — credentials reduced to "is one stored". */
export function toMcpServerView(row: McpServerRow, connectionCount = 0): McpServerView {
  const client = readStoredClient(row);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    url: row.url,
    transport: row.transport,
    auth_mode: row.auth_mode,
    auth_header: row.auth_header,
    auth_query_param: row.auth_query_param,
    auth_value_prefix: row.auth_value_prefix,
    has_auth_value: Boolean(row.auth_value_encrypted),
    credential_help: row.credential_help,
    credential_url: row.credential_url,
    oauth_scope: row.oauth_scope,
    oauth_client: client
      ? { source: client.source, client_id: client.client_id, has_secret: Boolean(client.client_secret) }
      : null,
    enabled: row.enabled,
    allowed_tools: row.allowed_tools ?? null,
    read_only_tools: row.read_only_tools ?? null,
    catalog_id: row.catalog_id,
    tools: Array.isArray(row.tools) ? row.tools : [],
    tools_refreshed_at: row.tools_refreshed_at,
    last_error: row.last_error,
    connection_count: connectionCount,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
