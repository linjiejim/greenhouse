/**
 * Connectors — the outside services (MCP servers) my agent reaches through
 * `mcp_call` (`/api/me/connectors`, apps/api/src/routes/connectors.ts). A
 * connector that runs on each member's own account needs my key or my
 * sign-in first; keys travel inward only — no answer carries a credential.
 * The phone connects, tests and disconnects; adding connectors (team or
 * personal) happens on the web.
 *
 * The shapes are the fields the app reads of `ConnectorMemberView` /
 * `ConnectorView` in packages/types/src/connectors.ts.
 */

import { del, get, post, put, seg } from './client';

export type ConnectorStatus = 'not_needed' | 'not_connected' | 'connected' | 'needs_reauth' | 'error';
export type ConnectorAuthMode = 'none' | 'shared' | 'per_member';
export type ConnectorAuthKind = 'key' | 'oauth';

export interface MyConnector {
  id: string;
  scope: 'team' | 'personal';
  slug: string;
  handle: string;
  name: string;
  description: string | null;
  auth_mode: ConnectorAuthMode;
  auth_kind: ConnectorAuthKind | null;
  status: ConnectorStatus;
  /** Team connectors: the reason my credential stopped working. */
  error?: string | null;
  /** Personal connectors: the last refresh's failure. */
  last_error?: string | null;
}

export interface MyConnectors {
  team: MyConnector[];
  personal: MyConnector[];
}

/** 403 = my account has no `mcp_call`; 404 = the station predates connectors. */
export const listMyConnectors = () => get<MyConnectors>('/api/me/connectors');

/** Store my key; the server tries it once and says whether it worked. */
export const saveConnectorKey = (id: string, key: string) =>
  put<{ ok: boolean; error: string | null; connector: MyConnector }>(`/api/me/connectors/${seg(id)}/key`, { key });

/** Start my sign-in: the provider page to open in the auth session (it returns to the app). */
export const startConnectorSignIn = (id: string) =>
  post<{ authorize_url: string }>(`/api/me/connectors/${seg(id)}/oauth/start`, { client: 'mobile' });

/** Finish a sign-in I started (the code + state the auth session came back with). */
export const finishConnectorSignIn = (code: string, state: string) =>
  post<{ connector_id: string; connector: MyConnector }>('/api/me/connectors/oauth/finish', { code, state });

export const testConnector = (id: string) =>
  post<{ ok: boolean; error: string | null; tool_count: number }>(`/api/me/connectors/${seg(id)}/test`);

export const disconnectConnector = (id: string) => del<{ ok: boolean }>(`/api/me/connectors/${seg(id)}/connection`);
