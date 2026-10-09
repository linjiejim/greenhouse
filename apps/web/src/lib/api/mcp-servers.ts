/**
 * External MCP servers (connectors) API — Administration (super only).
 *
 * The CLIENT side of MCP: servers members reach from chat and Bots through
 * `mcp_call`. Credentials only travel outbound — create/update accept a shared
 * value or a manual OAuth client secret, nothing returns them (`has_auth_value`
 * / `oauth_client.has_secret` say whether one is stored).
 */

import type {
  McpCatalogEntry,
  McpProbeResult,
  McpRegistryResult,
  McpServerInput,
  McpServerTransport,
  McpServerUpdate,
  McpServerView,
} from '@greenhouse/types/mcp-servers';
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

// ─── Catalog, Registry, probe ────────────────────────────

/** The official connector catalog, each entry marked with the slug it is installed under (if any). */
export async function fetchConnectorCatalog(): Promise<McpCatalogEntry[]> {
  const res = await rpc.api.admin['mcp-servers'].catalog.$get();
  if (!res.ok) return readError(res);
  return (await res.json()).entries;
}

/** Install a catalog entry as vetted (its read-only vouching comes with it). */
export async function installCatalogEntry(id: string, slug?: string): Promise<McpServerWriteResult> {
  const args = { json: { id, ...(slug ? { slug } : {}) } };
  const res = await rpc.api.admin['mcp-servers'].catalog.install.$post(args);
  if (!res.ok) return readError(res);
  return await res.json();
}

/** Search the official MCP Registry for remote servers (unvetted). */
export async function searchMcpRegistry(
  search: string,
): Promise<{ results: McpRegistryResult[]; error: string | null }> {
  const res = await rpc.api.admin['mcp-servers'].registry.$get({ query: { search } });
  if (!res.ok) return readError(res);
  return await res.json();
}

/** What an address asks for — none, a key, or a sign-in — before it is installed. */
export async function probeMcpServer(url: string, transport?: McpServerTransport): Promise<McpProbeResult> {
  const args = { json: { url, ...(transport ? { transport } : {}) } };
  const res = await rpc.api.admin['mcp-servers'].probe.$post(args);
  if (!res.ok) return readError(res);
  return await res.json();
}
