/** Shared transport fixture for core catalog and plugin integration tests. */
import type { Context } from 'hono';
import { expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import type { DataCatalog } from '@greenhouse/types/hub-context';
import { buildMcpServer, composeMcpContext } from '../../routes/mcp.js';
import { identityFromOAuthScopes } from '../../agent-runtime/mcp-auth.js';
import { filterMcpToolIdsByPlatform, MCP_PROFILE_ID } from '../../agent-runtime/mcp-tool-visibility.js';
import { resolveEffectiveTools } from '../../agent-runtime/tool-resolution.js';
import { MUTATING_PROXY_ALLOWLIST, resolveProxyToolIds } from '../../agent-runtime/tool-proxy.js';
import { MCP_EXPOSED_TOOL_IDS } from '../../tools/registry.js';
import { resolveProfileAsync } from '../../profiles/profile.js';
import { humanActor } from '../../plugin-host/actor.js';
import { buildDataCatalog } from '../catalog.js';

/** The MCP tools a grant of every resource group and `mcp:write` reaches for this member. */
export async function fullGrantReach(user: UserRow): Promise<Set<string>> {
  const userRole = user.role as 'team' | 'super';
  const profile = await resolveProfileAsync(MCP_PROFILE_ID);
  const { effectiveTools } = await resolveEffectiveTools({
    userId: user.id,
    userRole,
    profile,
    profileId: MCP_PROFILE_ID,
  });
  const ids = resolveProxyToolIds(effectiveTools, { allowedWriteTools: [...MUTATING_PROXY_ALLOWLIST] }).filter((id) =>
    MCP_EXPOSED_TOOL_IDS.has(id),
  );
  return new Set(await filterMcpToolIdsByPlatform({ userId: user.id }, ids));
}

/** The catalog a member's full grant reaches, built in process. */
export async function webCatalog(db: DatabaseProvider, user: UserRow): Promise<DataCatalog> {
  return buildDataCatalog({ db, actor: humanActor(user), reachable: await fullGrantReach(user) });
}

export async function mcpCatalog(user: UserRow, scopes: string[]): Promise<DataCatalog> {
  const identity = identityFromOAuthScopes({ id: user.id, role: user.role as 'team' | 'super' }, scopes);
  const ctx = await composeMcpContext(identity, {});
  const c = {
    get: (key: string) => (key === 'agentIdentity' ? identity : key === 'oauthClientId' ? 'catalog-client' : undefined),
    req: { method: 'POST', header: () => undefined },
  } as unknown as Context;
  const server = buildMcpServer(c, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  const result = (await client.callTool({ name: 'data_catalog', arguments: {} })) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]!.text) as DataCatalog;
}
