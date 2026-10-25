/**
 * Who a call to a connector is made AS.
 *
 * - `none`        — nobody: no credential is sent.
 * - `shared`      — the team's one credential, the same for every member: a key
 *   a super entered, or a super's OAuth sign-in.
 * - `per_member`  — this member's own key, or their own OAuth sign-in.
 *
 * A key goes where the connector says: a header (default `Authorization`) or a
 * query parameter, after an optional prefix (`Bearer `). The stored URL never
 * contains it; a target's URL may, so a target is never logged and every error
 * passes through `redactSecrets` first. OAuth sign-ins go through the SDK's
 * auth provider (oauth.ts), which adds the bearer token and refreshes it.
 */

import type { DatabaseProvider, McpConnectorRow, ProviderTokenRow } from '@greenhouse/db';
import type { ConnectorConnectionStatus } from '@greenhouse/types/connectors';
import { decryptToken, encryptToken } from '../auth/crypto.js';
import type { McpConnectTarget } from './client.js';
import { policyFor } from './network.js';
import {
  ConnectorOAuthProvider,
  connectionAad,
  openSharedTokens,
  readStoredClient,
  sharedAad,
  type SignInOwner,
} from './oauth.js';

export type NotConnectedReason = 'not_connected' | 'needs_reauth';

export type ResolvedTarget =
  | { ok: true; target: McpConnectTarget; secrets: string[]; owner: SignInOwner | null }
  | { ok: false; reason: NotConnectedReason; error: string };

type CredentialPlacement = Pick<McpConnectorRow, 'url' | 'auth_header' | 'auth_query_param' | 'auth_value_prefix'>;

/** Put a key where the connector says it goes. */
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

/**
 * Replace every known secret in a message — a transport error may echo a URL
 * (where a key is percent- or form-encoded) or a header.
 */
export function redactSecrets(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    const forms = new Set([
      secret,
      encodeURIComponent(secret),
      new URLSearchParams({ k: secret }).toString().slice(2),
      encodeURI(secret),
    ]);
    for (const form of [...forms].sort((a, b) => b.length - a.length)) {
      if (form.length >= 4) out = out.split(form).join('***');
    }
  }
  return out;
}

/** Seal a member's own key for their connection row. */
export function sealMemberKey(connectorId: string, userId: string, key: string): string {
  return encryptToken(key, connectionAad(connectorId, userId, 'credential'));
}

/** Seal the team's shared key. */
export function sealSharedKey(connectorId: string, key: string): string {
  return encryptToken(key, sharedAad(connectorId));
}

function openSharedKey(row: McpConnectorRow): string | null {
  if (!row.shared_secret_enc) return null;
  try {
    return decryptToken(row.shared_secret_enc, sharedAad(row.id));
  } catch {
    return null;
  }
}

/** Does the team's credential exist (and can this instance read it)? */
export function hasSharedCredential(row: McpConnectorRow): boolean {
  if (row.auth_mode !== 'shared') return false;
  return row.auth_kind === 'oauth' ? openSharedTokens(row) !== null : openSharedKey(row) !== null;
}

/** How a member stands with a connector, from their connection row. */
export function connectionStatus(
  row: McpConnectorRow,
  connection: ProviderTokenRow | undefined,
): ConnectorConnectionStatus {
  if (row.auth_mode === 'none') return 'not_needed';
  if (row.auth_mode === 'shared') return hasSharedCredential(row) ? 'not_needed' : 'not_connected';
  if (!connection) return 'not_connected';
  const status = (connection.metadata as { status?: unknown } | null)?.status;
  if (status === 'needs_reauth') return 'needs_reauth';
  if (status === 'error') return 'error';
  const hasSecret = row.auth_kind === 'oauth' ? !!connection.access_token_enc : !!connection.credential_enc;
  return hasSecret ? 'connected' : 'not_connected';
}

function notConnected(row: McpConnectorRow, reason: NotConnectedReason): ResolvedTarget {
  if (row.auth_mode === 'shared') {
    return {
      ok: false,
      reason,
      error: `${row.name} uses one team account and an administrator has not ${reason === 'needs_reauth' ? 'renewed' : 'set up'} its sign-in.`,
    };
  }
  const how = row.auth_kind === 'oauth' ? 'sign in to it' : 'add their own key for it';
  return {
    ok: false,
    reason,
    error:
      reason === 'needs_reauth'
        ? `The user's ${row.name} sign-in is no longer valid — they need to reconnect it.`
        : `${row.name} works with each user's own account and this user has not connected it yet — they need to ${how}.`,
  };
}

function base(row: McpConnectorRow): Pick<McpConnectTarget, 'url' | 'transport' | 'headers' | 'policy'> {
  return { url: row.url, transport: row.transport, headers: {}, policy: policyFor(row) };
}

function oauthTarget(db: DatabaseProvider, row: McpConnectorRow, owner: SignInOwner): ResolvedTarget {
  const client = readStoredClient(row);
  if (!client) return notConnected(row, 'needs_reauth');
  const provider = new ConnectorOAuthProvider({
    db,
    connector: row,
    owner,
    mode: 'call',
    // Only consulted if the SDK would start a new sign-in, which call mode refuses.
    redirectUri: client.redirect_uri ?? 'urn:greenhouse:connector-call',
  });
  return { ok: true, target: { ...base(row), authProvider: provider }, secrets: [], owner };
}

/**
 * The target for `userId` calling `row`, or why there is none. An OAuth
 * sign-in is only checked for existence; whether it still works shows on the
 * call (the provider refreshes, or raises ConnectorAuthorizationRequired).
 */
export async function resolveConnectTarget(
  db: DatabaseProvider,
  row: McpConnectorRow,
  userId: string,
): Promise<ResolvedTarget> {
  if (row.auth_mode === 'none') return { ok: true, target: base(row), secrets: [], owner: null };

  if (row.auth_mode === 'shared') {
    if (row.auth_kind === 'oauth') {
      return openSharedTokens(row) ? oauthTarget(db, row, { kind: 'shared' }) : notConnected(row, 'not_connected');
    }
    const secret = openSharedKey(row);
    if (!secret) return notConnected(row, row.shared_secret_enc ? 'needs_reauth' : 'not_connected');
    return {
      ok: true,
      target: { ...base(row), ...placeCredential(row, secret) },
      secrets: [secret],
      owner: { kind: 'shared' },
    };
  }

  const connection = await db.mcpConnectors.getConnection(userId, row.id);
  const status = connectionStatus(row, connection);
  if (status === 'not_connected') return notConnected(row, 'not_connected');
  if (status === 'needs_reauth') return notConnected(row, 'needs_reauth');
  const owner: SignInOwner = { kind: 'member', userId };
  if (row.auth_kind === 'oauth') return oauthTarget(db, row, owner);
  let secret: string;
  try {
    secret = decryptToken(connection!.credential_enc!, connectionAad(row.id, userId, 'credential'));
  } catch {
    // Bound to another member or connector (AAD), or the instance key changed.
    return notConnected(row, 'needs_reauth');
  }
  return { ok: true, target: { ...base(row), ...placeCredential(row, secret) }, secrets: [secret], owner };
}
