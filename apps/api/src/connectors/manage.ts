/**
 * Creating, changing and removing connectors — shared by the admin routes
 * (team connectors) and the member routes (personal connectors).
 *
 * - Shape first (`validateConnectorInput`), then the merged auth settings
 *   (`validateConnectorAuthConfig`), then the address (`connectorUrlProblem`;
 *   only a super's team connector may be marked as an internal service).
 * - Secrets are sealed with the connector id as AAD, so a new row is inserted
 *   first and its secrets written right after.
 * - Changing the address or how it authenticates drops every member credential
 *   (same transaction) and the server's OAuth state: a credential is only valid
 *   for the server and the scheme it was given for.
 * - Every write reloads the directory.
 */

import type { DatabaseProvider, McpConnectorPatch, McpConnectorRow } from '@greenhouse/db';
import {
  validateConnectorAuthConfig,
  validateConnectorInput,
  type ConnectorInput,
  type ConnectorScope,
  type ConnectorUpdate,
} from '@greenhouse/types/connectors';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { auditConnectorChange } from './audit.js';
import { findCatalogEntry } from './catalog.js';
import { sealSharedKey } from './credentials.js';
import { refreshConnectorDirectory, refreshConnectorTools } from './directory.js';
import { connectorUrlProblem } from './network.js';
import { readStoredClient, revokeMemberSignIn, revokeSharedSignIn, sealManualClient } from './oauth.js';

export class ConnectorInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'ConnectorInputError';
  }
}

export interface ConnectorActor {
  userId: string;
  role: string;
}

function isUniqueViolation(err: unknown): boolean {
  const code =
    (err as { code?: unknown; cause?: { code?: unknown } })?.code ??
    (err as { cause?: { code?: unknown } })?.cause?.code;
  return code === '23505' || /unique/i.test(toErrorMessage(err));
}

/** Fields a member may not set on a personal connector. */
function personalProblem(input: Partial<ConnectorInput>): string | null {
  if (input.auth_mode === 'shared') return 'a personal connector uses your own key or sign-in, not a shared one';
  if (input.private_network) return 'only an administrator can point a team connector into the private network';
  if (input.allow_external_writes) return 'external writes are a team connector setting';
  if (input.shared_secret) return 'a personal connector stores your key under your connection, not as a shared key';
  return null;
}

/** Create a connector; the caller has already checked who may create which scope. */
export async function createConnector(
  db: DatabaseProvider,
  actor: ConnectorActor,
  scope: ConnectorScope,
  input: ConnectorInput,
): Promise<McpConnectorRow> {
  const shape = validateConnectorInput(input);
  if (shape) throw new ConnectorInputError(shape);
  if (scope === 'personal') {
    const problem = personalProblem(input);
    if (problem) throw new ConnectorInputError(problem);
  }
  const authMode = input.auth_mode ?? 'none';
  const authKind = authMode === 'none' ? null : (input.auth_kind ?? null);
  const config = validateConnectorAuthConfig({
    scope,
    auth_mode: authMode,
    auth_kind: authKind,
    auth_header: input.auth_header ?? null,
    auth_query_param: input.auth_query_param ?? null,
    has_shared_key: Boolean(input.shared_secret),
    private_network: scope === 'team' && Boolean(input.private_network),
  });
  if (config) throw new ConnectorInputError(config);
  const urlProblem = connectorUrlProblem(input.url, {
    privateNetwork: scope === 'team' && Boolean(input.private_network),
  });
  if (urlProblem) throw new ConnectorInputError(urlProblem);

  const catalog = input.catalog_id ? findCatalogEntry(input.catalog_id) : undefined;
  let row: McpConnectorRow;
  try {
    row = await db.mcpConnectors.create({
      scope,
      owner_user_id: scope === 'personal' ? actor.userId : null,
      slug: input.slug,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      url: input.url,
      transport: input.transport ?? 'streamable_http',
      auth_mode: authMode,
      auth_kind: authKind,
      auth_header: authKind === 'key' ? (input.auth_header ?? (input.auth_query_param ? null : 'Authorization')) : null,
      auth_query_param: authKind === 'key' ? (input.auth_query_param ?? null) : null,
      auth_value_prefix: authKind === 'key' ? (input.auth_value_prefix ?? null) : null,
      oauth_scope: authKind === 'oauth' ? (input.oauth_scope ?? null) : null,
      private_network: scope === 'team' && Boolean(input.private_network),
      allow_external_writes: scope === 'team' && Boolean(input.allow_external_writes),
      tool_policy: input.tool_policy ?? {},
      vouched_read_only: input.vouched_read_only ?? catalog?.read_only_tools ?? [],
      enabled: input.enabled ?? true,
      catalog_id: catalog ? catalog.id : (input.catalog_id ?? null),
      created_by: actor.userId,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConnectorInputError(`A connector named "${input.slug}" already exists.`, 409);
    throw err;
  }

  if (authMode === 'shared' && authKind === 'key' && input.shared_secret) {
    await db.mcpConnectors.setSharedSecret(row.id, sealSharedKey(row.id, input.shared_secret));
  }
  if (authKind === 'oauth' && input.oauth_client_id) {
    await db.mcpConnectors.setOAuthClient(
      row.id,
      sealManualClient(row.id, input.oauth_client_id, input.oauth_client_secret || undefined),
    );
  }
  await auditConnectorChange(db, {
    userId: actor.userId,
    connectorId: row.id,
    action: 'createConnector',
    summary: { scope, slug: row.slug, auth_mode: row.auth_mode, auth_kind: row.auth_kind },
  });
  const created = (await db.mcpConnectors.getById(row.id)) ?? row;
  // List the tools now when the connector needs nobody's sign-in (or the team's key is in place).
  if (authMode === 'none' || (authMode === 'shared' && authKind === 'key')) {
    return (await refreshConnectorTools(db, created, actor.userId)).row;
  }
  await refreshConnectorDirectory(db);
  return created;
}

/** Apply an update; returns the new row. */
export async function updateConnector(
  db: DatabaseProvider,
  actor: ConnectorActor,
  row: McpConnectorRow,
  patch: ConnectorUpdate,
): Promise<McpConnectorRow> {
  const shape = validateConnectorInput(patch, { partial: true });
  if (shape) throw new ConnectorInputError(shape);
  if (row.scope === 'personal') {
    const problem = personalProblem(patch);
    if (problem) throw new ConnectorInputError(problem);
  }

  const url = patch.url ?? row.url;
  const transport = patch.transport ?? row.transport;
  const authMode = patch.auth_mode ?? row.auth_mode;
  const authKind = authMode === 'none' ? null : patch.auth_kind !== undefined ? patch.auth_kind : row.auth_kind;
  const privateNetwork = row.scope === 'team' && (patch.private_network ?? row.private_network);
  const schemeChanged = url !== row.url || authMode !== row.auth_mode || authKind !== row.auth_kind;

  // The shared key after the update: '' clears, a value replaces, omitted keeps (unless the scheme changed).
  const keepsSharedKey =
    authMode === 'shared' &&
    authKind === 'key' &&
    !schemeChanged &&
    Boolean(row.shared_secret_enc) &&
    row.auth_kind === 'key';
  const newSharedKey = patch.shared_secret === undefined ? null : patch.shared_secret;
  const hasSharedKey = newSharedKey !== null ? newSharedKey.length > 0 : keepsSharedKey;

  const authHeader =
    authKind !== 'key'
      ? null
      : patch.auth_header !== undefined || patch.auth_query_param !== undefined
        ? (patch.auth_header ?? null)
        : row.auth_header;
  const authQuery =
    authKind !== 'key'
      ? null
      : patch.auth_query_param !== undefined || patch.auth_header !== undefined
        ? (patch.auth_query_param ?? null)
        : row.auth_query_param;
  const config = validateConnectorAuthConfig({
    scope: row.scope,
    auth_mode: authMode,
    auth_kind: authKind,
    auth_header: authHeader,
    auth_query_param: authQuery,
    has_shared_key: authMode === 'shared' && authKind === 'key' ? hasSharedKey : Boolean(newSharedKey),
    private_network: privateNetwork,
  });
  if (config) throw new ConnectorInputError(config);
  if (url !== row.url || privateNetwork !== row.private_network) {
    const urlProblem = connectorUrlProblem(url, { privateNetwork });
    if (urlProblem) throw new ConnectorInputError(urlProblem);
  }

  // Revoke what is about to be dropped (best effort, before the rows go).
  if (schemeChanged) await revokeAll(db, row);

  const set: McpConnectorPatch = {
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.description !== undefined ? { description: patch.description?.trim() || null } : {}),
    url,
    transport,
    auth_mode: authMode,
    auth_kind: authKind,
    auth_header: authHeader,
    auth_query_param: authQuery,
    auth_value_prefix:
      authKind === 'key'
        ? patch.auth_value_prefix !== undefined
          ? patch.auth_value_prefix
          : row.auth_value_prefix
        : null,
    oauth_scope: authKind === 'oauth' ? (patch.oauth_scope !== undefined ? patch.oauth_scope : row.oauth_scope) : null,
    ...(row.scope === 'team' ? { private_network: privateNetwork } : {}),
    ...(row.scope === 'team' && patch.allow_external_writes !== undefined
      ? { allow_external_writes: patch.allow_external_writes }
      : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.tool_policy !== undefined ? { tool_policy: patch.tool_policy } : {}),
    ...(patch.vouched_read_only !== undefined ? { vouched_read_only: patch.vouched_read_only } : {}),
  };
  if (schemeChanged) {
    // The server's own OAuth state and the cached tools belong to the old address / scheme.
    set.oauth_discovery = null;
    set.tools = url !== row.url ? [] : row.tools;
    set.tools_refreshed_at = url !== row.url ? null : row.tools_refreshed_at;
    set.last_error = null;
    set.shared_secret_enc = null;
    if (authKind !== 'oauth' || url !== row.url) set.oauth_client_enc = null;
  } else if (authKind !== 'oauth') {
    set.oauth_client_enc = null;
  }
  if (!(authMode === 'shared' && authKind === 'key') && !schemeChanged && row.auth_kind === 'key') {
    set.shared_secret_enc = null;
  }

  const updated = await db.mcpConnectors.update(row.id, set, { dropCredentials: schemeChanged });
  if (!updated) throw new ConnectorInputError('Connector not found.', 404);

  if (authMode === 'shared' && authKind === 'key' && newSharedKey !== null) {
    await db.mcpConnectors.setSharedSecret(row.id, newSharedKey ? sealSharedKey(row.id, newSharedKey) : null);
  }
  if (authKind === 'oauth' && patch.oauth_client_id !== undefined) {
    const current = readStoredClient(updated);
    if (patch.oauth_client_id) {
      const secret =
        patch.oauth_client_secret !== undefined
          ? patch.oauth_client_secret || undefined
          : current?.source === 'manual' && current.client_id === patch.oauth_client_id
            ? current.client_secret
            : undefined;
      await db.mcpConnectors.setOAuthClient(row.id, sealManualClient(row.id, patch.oauth_client_id, secret));
    } else if (current?.source === 'manual') {
      await db.mcpConnectors.setOAuthClient(row.id, null);
    }
  }
  await auditConnectorChange(db, {
    userId: actor.userId,
    connectorId: row.id,
    action: 'updateConnector',
    summary: {
      slug: row.slug,
      fields: Object.keys(patch).filter((k) => k !== 'shared_secret' && k !== 'oauth_client_secret'),
      dropped_credentials: schemeChanged,
    },
  });
  const latest = (await db.mcpConnectors.getById(row.id)) ?? updated;
  if (schemeChanged && (authMode === 'none' || (authMode === 'shared' && authKind === 'key' && hasSharedKey))) {
    return (await refreshConnectorTools(db, latest, actor.userId)).row;
  }
  if (!schemeChanged && newSharedKey) return (await refreshConnectorTools(db, latest, actor.userId)).row;
  await refreshConnectorDirectory(db);
  return latest;
}

/** Best-effort revocation of every sign-in to a connector (before they are dropped). */
async function revokeAll(db: DatabaseProvider, row: McpConnectorRow): Promise<void> {
  if (row.auth_kind !== 'oauth') return;
  try {
    if (row.auth_mode === 'shared') await revokeSharedSignIn(row);
    const connections = (await db.mcpConnectors.listConnectionsForConnector(row.id)).slice(0, 100);
    await Promise.allSettled(connections.map((conn) => revokeMemberSignIn(row, conn.user_id, conn)));
  } catch (err) {
    logger.info('[connectors] revocation before a drop failed', { connector: row.id, error: toErrorMessage(err) });
  }
}

/** Delete a connector with every credential for it. */
export async function deleteConnector(
  db: DatabaseProvider,
  actor: ConnectorActor,
  row: McpConnectorRow,
): Promise<void> {
  await revokeAll(db, row);
  await db.mcpConnectors.delete(row.id);
  await auditConnectorChange(db, {
    userId: actor.userId,
    connectorId: row.id,
    action: 'deleteConnector',
    summary: { scope: row.scope, slug: row.slug },
  });
  await refreshConnectorDirectory(db);
}
