/**
 * Connectors — the outside services (MCP servers) my agent reaches through
 * `mcp_call` (`/api/me/connectors`, apps/api/src/routes/connectors.ts). A
 * connector that runs on each member's own account needs my key or my
 * sign-in first; keys travel inward only — no answer carries a credential.
 * Every client connects, tests and disconnects, and deletes or refreshes my own
 * (personal, `me/<slug>`) connectors; the browser also adds and edits them.
 * Team connectors are a super's (Admin › Team connectors).
 *
 * The shapes are the fields the app reads of `ConnectorMemberView` /
 * `ConnectorView` in packages/types/src/connectors.ts.
 */

import { del, get, patch, post, put, seg } from './client';

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

/** A personal connector as its owner reads it (`ConnectorView`): what its edit form starts from. */
export interface PersonalConnector extends MyConnector {
  url: string;
  transport: 'streamable_http' | 'sse';
  auth_header: string | null;
  auth_query_param: string | null;
  auth_value_prefix: string | null;
  oauth_client: { source: string; client_id: string; has_secret: boolean } | null;
  oauth_scope: string | null;
  tools: { name: string }[];
}

export interface MyConnectors {
  team: MyConnector[];
  personal: PersonalConnector[];
}

/** 403 = my account has no `mcp_call`. */
export const listMyConnectors = () => get<MyConnectors>('/api/me/connectors');

/** Store my key; the server tries it once and says whether it worked. */
export const saveConnectorKey = (id: string, key: string) =>
  put<{ ok: boolean; error: string | null; connector: MyConnector }>(`/api/me/connectors/${seg(id)}/key`, { key });

/**
 * Start my sign-in: the provider page to open. `mobile` returns to the app's scheme (the system
 * auth session), `web` to the browser client's `/connectors/oauth-finish`.
 */
export const startConnectorSignIn = (id: string, client: 'mobile' | 'web') =>
  post<{ authorize_url: string }>(`/api/me/connectors/${seg(id)}/oauth/start`, { client });

/** Finish a sign-in I started (the code + state the auth session came back with). */
export const finishConnectorSignIn = (code: string, state: string) =>
  post<{ connector_id: string; connector: MyConnector }>('/api/me/connectors/oauth/finish', { code, state });

export const testConnector = (id: string) =>
  post<{ ok: boolean; error: string | null; tool_count: number }>(`/api/me/connectors/${seg(id)}/test`);

export const disconnectConnector = (id: string) => del<{ ok: boolean }>(`/api/me/connectors/${seg(id)}/connection`);

/** My own connector (`ConnectorInput` minus team-only fields); the server refuses shared keys and private networks. */
export const createPersonalConnector = (input: Record<string, unknown>) =>
  post<PersonalConnector>('/api/me/connectors/personal', input);

export const updatePersonalConnector = (id: string, update: Record<string, unknown>) =>
  patch<PersonalConnector>(`/api/me/connectors/personal/${seg(id)}`, update);

export const deletePersonalConnector = (id: string) => del<{ ok: boolean }>(`/api/me/connectors/personal/${seg(id)}`);

/** List its tools again; `ok: false` keeps the old list and says why. */
export const refreshPersonalConnector = (id: string) =>
  post<{ connector: PersonalConnector; ok: boolean; error: string | null }>(
    `/api/me/connectors/personal/${seg(id)}/refresh`,
  );
