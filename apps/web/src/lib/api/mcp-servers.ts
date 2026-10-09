/**
 * External MCP servers API — Administration (super only).
 *
 * The CLIENT side of MCP: servers members reach from chat through `mcp_call`.
 * The auth header value only travels outbound — create/update accept it,
 * nothing returns it (`has_auth_value` says whether one is stored).
 */

import type { McpServerInput, McpServerUpdate, McpServerView } from '@greenhouse/types/mcp-servers';
import { rpc } from './client';

/** Every write answers with the row and, when discovery ran, how it went. */
export interface McpServerWriteResult {
  server: McpServerView;
  refresh: { ok: boolean; error: string | null } | null;
}

async function readError(res: Response): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? `Request failed (${res.status})`);
}

export async function fetchMcpServers(): Promise<McpServerView[]> {
  const res = await rpc.api.admin['mcp-servers'].$get();
  if (!res.ok) return readError(res);
  return (await res.json()).servers;
}

export async function createMcpServer(input: McpServerInput): Promise<McpServerWriteResult> {
  // Non-literal arg: hc only types `json` for validator-backed routes.
  const args = { json: input };
  const res = await rpc.api.admin['mcp-servers'].$post(args);
  if (!res.ok) return readError(res);
  return await res.json();
}

export async function updateMcpServer(id: number, input: McpServerUpdate): Promise<McpServerWriteResult> {
  const args = { param: { id: String(id) }, json: input };
  const res = await rpc.api.admin['mcp-servers'][':id'].$put(args);
  if (!res.ok) return readError(res);
  return await res.json();
}

export async function deleteMcpServer(id: number): Promise<void> {
  const res = await rpc.api.admin['mcp-servers'][':id'].$delete({ param: { id: String(id) } });
  if (!res.ok) return readError(res);
}

export async function refreshMcpServer(id: number): Promise<McpServerWriteResult> {
  const res = await rpc.api.admin['mcp-servers'][':id'].refresh.$post({ param: { id: String(id) } });
  if (!res.ok) return readError(res);
  return await res.json();
}
