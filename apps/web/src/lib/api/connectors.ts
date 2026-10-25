/**
 * Connectors — outside MCP services the agent reaches through `mcp_call`.
 *
 * Admin (`/api/admin/connectors`, super): team connectors, the official
 * catalog, probing an address. Member (`/api/me/connectors`): connecting team
 * connectors with my own key or sign-in, and my personal connectors.
 *
 * Secrets travel inward only: every answer carries "is one stored", never a
 * key, a token or a client secret.
 */

import type {
  ConnectorCatalogEntry,
  ConnectorInput,
  ConnectorMemberView,
  ConnectorProbeResult,
  ConnectorTransport,
  ConnectorUpdate,
  ConnectorView,
} from '@greenhouse/types/connectors';
import { rpc } from './client';

async function fail(res: Response): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  throw Object.assign(new Error(typeof body.error === 'string' ? body.error : `Request failed (${res.status})`), {
    status: res.status,
  });
}

export interface RefreshResult {
  connector: ConnectorView;
  ok: boolean;
  error: string | null;
}

// ─── Admin ───────────────────────────────────────────────

export async function fetchTeamConnectors(): Promise<ConnectorView[]> {
  const res = await rpc.api.admin.connectors.$get();
  if (!res.ok) return fail(res);
  return (await res.json()).connectors;
}

export async function fetchConnectorCatalog(): Promise<ConnectorCatalogEntry[]> {
  const res = await rpc.api.admin.connectors.catalog.$get();
  if (!res.ok) return fail(res);
  return (await res.json()).entries;
}

export async function probeConnector(input: {
  url: string;
  transport?: ConnectorTransport;
  private_network?: boolean;
}): Promise<ConnectorProbeResult> {
  const res = await rpc.api.admin.connectors.probe.$post({ json: input });
  if (!res.ok) return fail(res);
  return await res.json();
}

export async function createTeamConnector(input: ConnectorInput): Promise<ConnectorView> {
  const res = await rpc.api.admin.connectors.$post({ json: input });
  if (!res.ok) return fail(res);
  return await res.json();
}

export async function updateTeamConnector(id: string, patch: ConnectorUpdate): Promise<ConnectorView> {
  // Non-literal arg: hc only types `json` for validator-backed routes.
  const args = { param: { id }, json: patch };
  const res = await rpc.api.admin.connectors[':id'].$patch(args);
  if (!res.ok) return fail(res);
  return await res.json();
}

export async function deleteTeamConnector(id: string): Promise<void> {
  const res = await rpc.api.admin.connectors[':id'].$delete({ param: { id } });
  if (!res.ok) return fail(res);
}

export async function refreshTeamConnector(id: string): Promise<RefreshResult> {
  const res = await rpc.api.admin.connectors[':id'].refresh.$post({ param: { id } });
  if (!res.ok) return fail(res);
  return await res.json();
}

/** Team sign-in (shared + OAuth): the provider page to open. */
export async function startTeamSignIn(id: string): Promise<string> {
  // Non-literal arg: hc only types `json` for validator-backed routes.
  const args = { param: { id }, json: { client: 'web' } };
  const res = await rpc.api.admin.connectors[':id'].oauth.start.$post(args);
  if (!res.ok) return fail(res);
  return (await res.json()).authorize_url;
}

export async function clearTeamSignIn(id: string): Promise<ConnectorView> {
  const res = await rpc.api.admin.connectors[':id'].oauth.$delete({ param: { id } });
  if (!res.ok) return fail(res);
  return await res.json();
}

// ─── Member ──────────────────────────────────────────────

export interface MyConnectors {
  /** false = my account has no `mcp_call` (the API answers 403). */
  enabled: boolean;
  team: ConnectorMemberView[];
  personal: ConnectorView[];
}

export async function fetchMyConnectors(): Promise<MyConnectors> {
  const res = await rpc.api.me.connectors.$get();
  if (res.status === 403) return { enabled: false, team: [], personal: [] };
  if (!res.ok) return fail(res);
  const body = await res.json();
  return { enabled: true, team: body.team, personal: body.personal };
}

export async function createPersonalConnector(input: ConnectorInput): Promise<ConnectorView> {
  const res = await rpc.api.me.connectors.personal.$post({ json: input });
  if (!res.ok) return fail(res);
  return await res.json();
}

export async function updatePersonalConnector(id: string, patch: ConnectorUpdate): Promise<ConnectorView> {
  // Non-literal arg: hc only types `json` for validator-backed routes.
  const args = { param: { id }, json: patch };
  const res = await rpc.api.me.connectors.personal[':id'].$patch(args);
  if (!res.ok) return fail(res);
  return await res.json();
}

export async function deletePersonalConnector(id: string): Promise<void> {
  const res = await rpc.api.me.connectors.personal[':id'].$delete({ param: { id } });
  if (!res.ok) return fail(res);
}

export async function refreshPersonalConnector(id: string): Promise<RefreshResult> {
  const res = await rpc.api.me.connectors.personal[':id'].refresh.$post({ param: { id } });
  if (!res.ok) return fail(res);
  return await res.json();
}

export interface KeyResult {
  connector: ConnectorMemberView;
  ok: boolean;
  error: string | null;
}

/** Store my own key; the server tries it once and says whether it worked. */
export async function saveConnectorKey(id: string, key: string): Promise<KeyResult> {
  // Non-literal arg: hc only types `json` for validator-backed routes.
  const args = { param: { id }, json: { key } };
  const res = await rpc.api.me.connectors[':id'].key.$put(args);
  if (!res.ok) return fail(res);
  const body = await res.json();
  return { connector: body.connector, ok: body.ok, error: body.error ?? null };
}

/** Start my own sign-in: the provider page to open. */
export async function startConnectorSignIn(id: string): Promise<string> {
  // Non-literal arg: hc only types `json` for validator-backed routes.
  const args = { param: { id }, json: { client: 'web' } };
  const res = await rpc.api.me.connectors[':id'].oauth.start.$post(args);
  if (!res.ok) return fail(res);
  return (await res.json()).authorize_url;
}

/** Finish a sign-in this member started (the callback page passes code + state through). */
export async function finishConnectorSignIn(
  code: string,
  state: string,
): Promise<{ connector_id: string; connector: ConnectorMemberView }> {
  const res = await rpc.api.me.connectors.oauth.finish.$post({ json: { code, state } });
  if (!res.ok) return fail(res);
  return await res.json();
}

export async function disconnectConnector(id: string): Promise<void> {
  const res = await rpc.api.me.connectors[':id'].connection.$delete({ param: { id } });
  if (!res.ok) return fail(res);
}

export async function testConnector(id: string): Promise<{ ok: boolean; error: string | null; tool_count: number }> {
  const res = await rpc.api.me.connectors[':id'].test.$post({ param: { id } });
  if (!res.ok) return fail(res);
  const body = await res.json();
  return { ok: body.ok, error: body.error ?? null, tool_count: body.tool_count ?? 0 };
}
