/**
 * The connector directory — what `mcp_call` can see, kept in memory.
 *
 * Chat builds its tools on every turn and lists the connectors a member can
 * use in the turn context; neither may wait on a remote server or a query per
 * connector. So the enabled connectors (with the tools each advertised at its
 * last refresh, minus switched-off tools) live in a snapshot here: loaded at
 * boot and reloaded after every admin or member write. `version` changes with
 * every reload; the `/api/mcp` context cache keys on it.
 *
 * Whether a member has connected a per_member connector is NOT in the
 * snapshot: it is read per turn (one query) and per call.
 *
 * Single-process, like the other in-memory registries: a multi-node deployment
 * would need a restart (or a shared invalidation) to see a change.
 */

import { getDb, type DatabaseProvider, type McpConnectorRow, type ProviderTokenRow } from '@greenhouse/db';
import {
  connectorHandle,
  connectorToolKind,
  isConnectorToolEnabled,
  isConnectorToolReadOnly,
  type ConnectorAuthKind,
  type ConnectorAuthMode,
  type ConnectorMemberView,
  type ConnectorScope,
  type ConnectorTool,
  type ConnectorToolKind,
  type ConnectorToolView,
  type ConnectorView,
} from '@greenhouse/types/connectors';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { describeMcpError, discoverMcpTools, explainFailedConnect } from './client.js';
import { connectionStatus, hasSharedCredential, redactSecrets, resolveConnectTarget } from './credentials.js';
import { readStoredClient, withSignInLock } from './oauth.js';

export interface DirectoryTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  kind: ConnectorToolKind;
}

export interface DirectoryConnector {
  id: string;
  scope: ConnectorScope;
  owner_user_id: string | null;
  slug: string;
  /** What the model passes as `connector` (`me/<slug>` for a personal one). */
  handle: string;
  name: string;
  description: string | null;
  auth_mode: ConnectorAuthMode;
  auth_kind: ConnectorAuthKind | null;
  allow_external_writes: boolean;
  /** Only the switched-on tools. */
  tools: DirectoryTool[];
  /** Names of advertised tools switched off, so the model can say so instead of claiming they don't exist. */
  switched_off: string[];
}

let snapshot: readonly DirectoryConnector[] = [];
let version = 0;

/** Every advertised tool with its switch and kind (admin / owner views). */
export function toolViews(
  row: Pick<McpConnectorRow, 'tools' | 'tool_policy' | 'vouched_read_only'>,
): ConnectorToolView[] {
  const advertised: ConnectorTool[] = Array.isArray(row.tools) ? row.tools : [];
  return advertised.map((tool) => ({
    ...tool,
    kind: connectorToolKind(tool, row.vouched_read_only),
    enabled: isConnectorToolEnabled(tool, row.tool_policy, row.vouched_read_only),
    vouched: !tool.read_only && isConnectorToolReadOnly(tool, row.vouched_read_only),
  }));
}

export function toDirectoryConnector(row: McpConnectorRow): DirectoryConnector {
  return {
    id: row.id,
    scope: row.scope,
    owner_user_id: row.owner_user_id,
    slug: row.slug,
    handle: connectorHandle(row),
    name: row.name,
    description: row.description,
    auth_mode: row.auth_mode,
    auth_kind: row.auth_kind,
    allow_external_writes: row.allow_external_writes,
    tools: toolViews(row)
      .filter((tool) => tool.enabled)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
        kind: tool.kind,
      })),
    switched_off: toolViews(row)
      .filter((tool) => !tool.enabled)
      .map((tool) => tool.name),
  };
}

/** Reload the snapshot from the database. Never throws — a failure keeps the old one. */
export async function refreshConnectorDirectory(db: DatabaseProvider = getDb()): Promise<void> {
  try {
    const rows = await db.mcpConnectors.listEnabled();
    snapshot = rows
      .map(toDirectoryConnector)
      // Nothing callable is not a capability yet (never refreshed, or every tool
      // switched off) — except one that works with each member's own account:
      // its tools are unknown until someone connects, and calling it meanwhile
      // shows the member a Connect card.
      .filter((c) => c.tools.length > 0 || c.auth_mode === 'per_member');
    version++;
  } catch (err) {
    logger.warn('[connectors] could not load the connector directory', { error: toErrorMessage(err) });
  }
}

export function getConnectorDirectory(): readonly DirectoryConnector[] {
  return snapshot;
}

/** Changes with every reload — part of the `/api/mcp` context cache key. */
export function connectorDirectoryVersion(): number {
  return version;
}

/** Test seam. */
export function _setConnectorDirectory(connectors: readonly DirectoryConnector[]): void {
  snapshot = connectors;
  version++;
}

/**
 * The connectors one member's agent can use: team ones plus their own
 * personal ones, narrowed by an agent's `connectors` list (null = all; ids).
 */
export function connectorsForUser(
  userId: string,
  allowed: readonly string[] | null | undefined = null,
): DirectoryConnector[] {
  const narrow = allowed ? new Set(allowed) : null;
  return snapshot.filter((c) => (c.scope === 'team' || c.owner_user_id === userId) && (!narrow || narrow.has(c.id)));
}

/** Look a handle up within what a member can use. */
export function findConnector(
  userId: string,
  handle: string,
  allowed: readonly string[] | null | undefined = null,
): DirectoryConnector | undefined {
  const wanted = handle.trim().toLowerCase();
  return connectorsForUser(userId, allowed).find((c) => c.handle === wanted);
}

// ─── Refreshing a connector's tools ─────────────────────

export type RefreshOutcome = { row: McpConnectorRow; ok: boolean; error?: string };

/**
 * Connect as `actorUserId`, list the tools and record the outcome on the row.
 * A failed refresh keeps the previous list (a flaky server keeps working from
 * its last known tools); `last_error` says what went wrong.
 *
 * A per_member connector is listed with the ACTOR's own credential. An actor
 * who has not connected gets the reason back, but nothing is recorded (that is
 * their state, not the connector's) — and the directory is still reloaded, so
 * a new connector shows up for members (who see a Connect card) right away.
 */
export async function refreshConnectorTools(
  db: DatabaseProvider,
  row: McpConnectorRow,
  actorUserId: string,
): Promise<RefreshOutcome> {
  const resolved = await resolveConnectTarget(db, row, actorUserId);
  if (!resolved.ok) {
    await refreshConnectorDirectory(db);
    const error =
      row.auth_mode === 'shared'
        ? 'Set up the team credential first — the tools are listed with it.'
        : row.auth_kind === 'oauth'
          ? 'Connect your own account first — the tools are listed with your sign-in.'
          : 'Add your own key first — the tools are listed with your key.';
    return { row, ok: false, error };
  }
  let outcome: { ok: true; tools: ConnectorTool[] } | { ok: false; error: string };
  try {
    const list = () => discoverMcpTools(resolved.target);
    const tools =
      resolved.target.authProvider && resolved.owner
        ? await withSignInLock(row.id, resolved.owner, list)
        : await list();
    outcome = { ok: true, tools };
  } catch (err) {
    const better = resolved.target.authProvider ? null : await explainFailedConnect(resolved.target);
    outcome = { ok: false, error: redactSecrets(better ?? describeMcpError(err), resolved.secrets) };
  }
  const updated = (await db.mcpConnectors.recordRefresh(row.id, outcome)) ?? row;
  await refreshConnectorDirectory(db);
  return outcome.ok ? { row: updated, ok: true } : { row: updated, ok: false, error: outcome.error };
}

/**
 * After someone connects: if nobody has listed the tools yet, use the fresh
 * credential to do it. Failures only log — the connection itself succeeded.
 */
export async function discoverIfEmpty(db: DatabaseProvider, connectorId: string, userId: string): Promise<void> {
  const row = await db.mcpConnectors.getById(connectorId);
  if (!row) return;
  if (Array.isArray(row.tools) && row.tools.length > 0) {
    await refreshConnectorDirectory(db);
    return;
  }
  const result = await refreshConnectorTools(db, row, userId);
  if (!result.ok) {
    logger.info('[connectors] first discovery after a connection failed', { connector: row.id, error: result.error });
  }
}

// ─── Views ───────────────────────────────────────────────

/** The admin / owner view of a row — credentials reduced to "is one stored". */
export function toConnectorView(
  row: McpConnectorRow,
  opts: { connectionCount?: number; connection?: ProviderTokenRow } = {},
): ConnectorView {
  const client = readStoredClient(row);
  return {
    id: row.id,
    scope: row.scope,
    owner_user_id: row.owner_user_id,
    slug: row.slug,
    handle: connectorHandle(row),
    name: row.name,
    description: row.description,
    url: row.url,
    transport: row.transport,
    auth_mode: row.auth_mode,
    auth_kind: row.auth_kind,
    auth_header: row.auth_header,
    auth_query_param: row.auth_query_param,
    auth_value_prefix: row.auth_value_prefix,
    has_shared_secret: hasSharedCredential(row),
    oauth_client: client
      ? { source: client.source, client_id: client.client_id, has_secret: Boolean(client.client_secret) }
      : null,
    oauth_scope: row.oauth_scope,
    private_network: row.private_network,
    allow_external_writes: row.allow_external_writes,
    tools: toolViews(row),
    tools_refreshed_at: row.tools_refreshed_at,
    last_error: row.last_error,
    enabled: row.enabled,
    catalog_id: row.catalog_id,
    connection_count: opts.connectionCount ?? 0,
    status: connectionStatus(row, opts.connection),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** A connector as one member sees it. */
export function toMemberView(row: McpConnectorRow, connection: ProviderTokenRow | undefined): ConnectorMemberView {
  const meta = (connection?.metadata ?? {}) as { last_error?: unknown };
  return {
    id: row.id,
    scope: row.scope,
    slug: row.slug,
    handle: connectorHandle(row),
    name: row.name,
    description: row.description,
    auth_mode: row.auth_mode,
    auth_kind: row.auth_kind,
    catalog_id: row.catalog_id,
    tool_count: toolViews(row).filter((t) => t.enabled).length,
    status: connectionStatus(row, connection),
    connected_at: connection?.updated_at ?? null,
    error: typeof meta.last_error === 'string' ? meta.last_error : null,
  };
}
