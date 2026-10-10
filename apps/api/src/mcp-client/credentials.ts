/**
 * Who a call to a connector is made AS (spec 20261009-mcp-connectors D2).
 *
 * - `none`     — nobody: no credential is sent;
 * - `shared`   — the admin's one credential, the same for every member;
 * - `per_user` — this member's own key, from their connection;
 * - `oauth`    — this member's sign-in: the SDK adds the bearer token and
 *   refreshes it through the DB-backed provider (oauth.ts).
 *
 * A credential goes where the connector says: a header (default
 * `Authorization`) or a query parameter, after an optional prefix
 * (`Bearer `). The stored URL never contains it; the target's URL does, so a
 * target is never logged and errors pass through `redactSecrets` first.
 */

import type { DatabaseProvider, McpServerRow } from '@greenhouse/db';
import { decryptToken, encryptToken } from '../auth/crypto.js';
import type { McpConnectTarget } from './client.js';
import { ConnectorOAuthProvider, connectionAad, readStoredClient } from './oauth.js';

export type ResolvedTarget =
  | { ok: true; target: McpConnectTarget; secrets: string[] }
  | { ok: false; reason: 'not_connected' | 'expired'; error: string };

type CredentialPlacement = Pick<McpServerRow, 'url' | 'auth_header' | 'auth_query_param' | 'auth_value_prefix'>;

/** Put a credential where the connector says it goes. */
export function placeCredential(
  row: CredentialPlacement,
  secret: string,
): { url: string; headers: Record<string, string> } {
  const value = `${row.auth_value_prefix ?? ''}${secret}`;
  if (row.auth_query_param) {
    const url = new URL(row.url);
    url.searchParams.set(row.auth_query_param, value);
    return { url: url.toString(), headers: {} };
  }
  return { url: row.url, headers: { [row.auth_header || 'Authorization']: value } };
}

/** Replace every known secret in a message — a transport error may echo a URL or a header. */
export function redactSecrets(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join('***');
  }
  return out;
}

/** Seal a member's own key for their connection row. */
export function sealMemberCredential(serverId: number, userId: string, key: string): string {
  return encryptToken(key, connectionAad(serverId, userId, 'credential'));
}

function notConnected(row: McpServerRow, reason: 'not_connected' | 'expired'): ResolvedTarget {
  const how = row.auth_mode === 'oauth' ? 'sign in to it' : 'add their own key for it';
  return {
    ok: false,
    reason,
    error:
      reason === 'expired'
        ? `The user's ${row.name} sign-in is no longer valid — they need to reconnect it.`
        : `${row.name} works with each user's own account and this user has not connected it yet — they need to ${how}.`,
  };
}

/**
 * The target for `userId` calling `row`, or why there is none. The OAuth case
 * only checks that a sign-in exists; whether it still works shows on the call
 * (the provider refreshes, or raises ConnectorAuthorizationRequired).
 */
export async function resolveConnectTarget(
  db: DatabaseProvider,
  row: McpServerRow,
  userId: string,
): Promise<ResolvedTarget> {
  switch (row.auth_mode) {
    case 'none':
      return { ok: true, target: { url: row.url, transport: row.transport, headers: {} }, secrets: [] };

    case 'shared': {
      if (!row.auth_value_encrypted) {
        return { ok: true, target: { url: row.url, transport: row.transport, headers: {} }, secrets: [] };
      }
      const secret = decryptToken(row.auth_value_encrypted);
      return { ok: true, target: { ...placeCredential(row, secret), transport: row.transport }, secrets: [secret] };
    }

    case 'per_user': {
      const connection = await db.mcpServers.getConnection(userId, row.id);
      if (!connection?.provider_credential) return notConnected(row, 'not_connected');
      let secret: string;
      try {
        secret = decryptToken(connection.provider_credential, connectionAad(row.id, userId, 'credential'));
      } catch {
        // Bound to another member or connector (AAD), or the instance key changed.
        return notConnected(row, 'expired');
      }
      return { ok: true, target: { ...placeCredential(row, secret), transport: row.transport }, secrets: [secret] };
    }

    case 'oauth': {
      const connection = await db.mcpServers.getConnection(userId, row.id);
      if (!connection?.access_token) return notConnected(row, connection ? 'expired' : 'not_connected');
      const client = readStoredClient(row);
      if (!client) return notConnected(row, 'expired');
      const provider = new ConnectorOAuthProvider({
        db,
        server: row,
        userId,
        mode: 'call',
        // Only consulted if the SDK would start a new sign-in, which call mode refuses.
        redirectUri: client.redirect_uri ?? 'urn:greenhouse:connector-call',
      });
      return {
        ok: true,
        target: { url: row.url, transport: row.transport, headers: {}, authProvider: provider },
        secrets: [],
      };
    }
  }
}
