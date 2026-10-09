/**
 * Connectors — a member's own connections to the MCP servers an admin
 * installed (`/api/connectors`, apps/api/src/routes/connectors.ts; spec
 * 20261009-mcp-connectors). A connector that runs on each member's account
 * needs their key (`per_user`) or their sign-in (`oauth`) before the agent can
 * call it; keys only travel inward — no answer carries a credential.
 *
 * The shapes mirror `McpConnectorView` / `McpNeedsConnection` in
 * packages/types/src/mcp-servers.ts (the fields the app reads).
 */

import { api } from './client';

export type ConnectorAuth = 'none' | 'shared' | 'per_user' | 'oauth';
/** not_needed (none / shared — it just works) · not_connected · connected · expired (sign in again). */
export type ConnectorStatus = 'not_needed' | 'not_connected' | 'connected' | 'expired';

export interface Connector {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  auth_mode: ConnectorAuth;
  /** Where to get a key (per_user), in the admin's words / a link. */
  credential_help: string | null;
  credential_url: string | null;
  tool_count: number;
  status: ConnectorStatus;
  connected_at: string | null;
  /** Why an expired sign-in stopped working. */
  error: string | null;
}

/** What `mcp_call` answers when the member has to connect first — the chat shows a "Connect" card. */
export interface NeedsConnection {
  needs_connection: true;
  server: string;
  server_name: string;
  server_id: number;
  auth: 'per_user' | 'oauth';
  reason: 'not_connected' | 'expired';
}

export function isNeedsConnection(value: unknown): value is NeedsConnection {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.needs_connection === true && typeof v.server_name === 'string' && typeof v.server_id === 'number';
}

/** A write's outcome: ok, or the server's sentence (a refused key says why). */
export type ConnectorResult<T> = { ok: true; value: T } | { ok: false; message: string };

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
}

async function call<T>(path: string, init: RequestInit | undefined, read: (body: unknown) => T): Promise<ConnectorResult<T>> {
  try {
    const res = await api(path, init);
    if (!res.ok) return { ok: false, message: await errorOf(res) };
    return { ok: true, value: read(await res.json().catch(() => ({}))) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** The connectors I can use; `enabled: false` = my account has no external tools. null = couldn't load. */
export async function listConnectors(): Promise<{ enabled: boolean; connectors: Connector[] } | null> {
  const result = await call('/api/connectors', undefined, (body) => body as { enabled: boolean; connectors: Connector[] });
  return result.ok ? result.value : null;
}

/** OAuth: the provider's sign-in page to open. */
export function startConnectorSignIn(id: number): Promise<ConnectorResult<string>> {
  return call(`/api/connectors/${id}/authorize`, { method: 'POST' }, (body) => (body as { url: string }).url);
}

/** per_user: store my own key — the server tries it with one call first (a typo fails here). */
export function saveConnectorKey(id: number, key: string): Promise<ConnectorResult<void>> {
  return call(
    `/api/connectors/${id}/key`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) },
    () => undefined,
  );
}

/** List the tools with my connection: how many, or why not. */
export async function testConnector(id: number): Promise<ConnectorResult<number>> {
  const result = await call(
    `/api/connectors/${id}/test`,
    { method: 'POST' },
    (body) => body as { ok: boolean; tool_count?: number; error: string | null },
  );
  if (!result.ok) return result;
  return result.value.ok
    ? { ok: true, value: result.value.tool_count ?? 0 }
    : { ok: false, message: result.value.error ?? '' };
}

export function disconnectConnector(id: number): Promise<ConnectorResult<void>> {
  return call(`/api/connectors/${id}`, { method: 'DELETE' }, () => undefined);
}
