/**
 * Connector rules the screens share, React-free (./model.test.ts):
 * which connectors 「我」 → 连接 lists, how a sign-in's return address reads,
 * and what `mcp_call` answers when I have to connect first.
 */

import type { ConnectorAuthKind, ConnectorStatus, MyConnector, MyConnectors } from '../api/connectors';

/** The app's return address — apps/api/src/connectors/oauth.ts `CONNECTOR_APP_REDIRECT`. */
export const CONNECTOR_APP_REDIRECT = 'greenhouse://connectors/oauth-finish';

export type ConnectorReturn =
  | { kind: 'code'; code: string; state: string }
  | { kind: 'error'; reason: string }
  | { kind: 'cancel' };

/** The URL the auth session ended on → what it says. Anything not ours is a cancel. */
export function parseConnectorReturn(url: string | null | undefined): ConnectorReturn {
  if (!url || !url.startsWith(`${CONNECTOR_APP_REDIRECT}?`)) return { kind: 'cancel' };
  const params = new URLSearchParams(url.slice(CONNECTOR_APP_REDIRECT.length + 1));
  const code = params.get('code');
  const state = params.get('state');
  if (code && state) return { kind: 'code', code, state };
  const error = params.get('error');
  return error ? { kind: 'error', reason: error.slice(0, 64) } : { kind: 'cancel' };
}

/**
 * The team's connectors that need something from me (my key or sign-in), the team's that are ready
 * to use, and my own (personal) ones, which I also edit, refresh and delete.
 */
export function connectorSections(list: MyConnectors): {
  mine: MyConnector[];
  ready: MyConnector[];
  own: MyConnectors['personal'];
} {
  return {
    mine: list.team.filter((c) => c.auth_mode === 'per_member'),
    ready: list.team.filter((c) => c.auth_mode !== 'per_member'),
    own: list.personal,
  };
}

export const STATUS_LABEL: Record<ConnectorStatus, `connectors.status.${ConnectorStatus}`> = {
  not_needed: 'connectors.status.not_needed',
  not_connected: 'connectors.status.not_connected',
  connected: 'connectors.status.connected',
  needs_reauth: 'connectors.status.needs_reauth',
  error: 'connectors.status.error',
};

/** `mcp_call`'s "connect first" answer, as the chat card reads it. */
export interface NeedsConnection {
  connectorId: string;
  name: string;
  authKind: ConnectorAuthKind;
  reason: 'not_connected' | 'needs_reauth';
}

export function needsConnection(output: unknown): NeedsConnection | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const o = output as Record<string, unknown>;
  if (o.needs_connection !== true || typeof o.connector_id !== 'string' || !o.connector_id) return null;
  return {
    connectorId: o.connector_id,
    name: typeof o.connector_name === 'string' && o.connector_name ? o.connector_name : String(o.connector ?? ''),
    authKind: o.auth_kind === 'oauth' ? 'oauth' : 'key',
    reason: o.reason === 'needs_reauth' ? 'needs_reauth' : 'not_connected',
  };
}
