/**
 * Connectors API — a member's own connections to installed MCP servers
 * (spec 20261009-mcp-connectors). Keys and tokens only travel inward: the
 * server answers with connection states, never a credential.
 */

import type { McpConnectorView } from '@greenhouse/types/mcp-servers';
import { rpc } from './client';

async function readError(res: Response): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? `Request failed (${res.status})`);
}

/** The connectors I can use; `enabled: false` = my account has no `mcp_call`. */
export async function fetchMyConnectors(): Promise<{ enabled: boolean; connectors: McpConnectorView[] }> {
  const res = await rpc.api.connectors.$get();
  if (!res.ok) return readError(res);
  return await res.json();
}

/** Start an OAuth sign-in: the provider's authorization URL to open. */
export async function startConnectorSignIn(id: number): Promise<string> {
  const res = await rpc.api.connectors[':id'].authorize.$post({ param: { id: String(id) } });
  if (!res.ok) return readError(res);
  return (await res.json()).url;
}

/** Store my own key (the server verifies it with one call first). */
export async function saveConnectorKey(id: number, key: string): Promise<McpConnectorView | null> {
  const args = { param: { id: String(id) }, json: { key } };
  const res = await rpc.api.connectors[':id'].key.$put(args);
  if (!res.ok) return readError(res);
  return (await res.json()).connector;
}

export async function testConnector(id: number): Promise<{ ok: boolean; tool_count?: number; error: string | null }> {
  const res = await rpc.api.connectors[':id'].test.$post({ param: { id: String(id) } });
  if (!res.ok) return readError(res);
  return await res.json();
}

export async function disconnectConnector(id: number): Promise<void> {
  const res = await rpc.api.connectors[':id'].$delete({ param: { id: String(id) } });
  if (!res.ok) return readError(res);
}
