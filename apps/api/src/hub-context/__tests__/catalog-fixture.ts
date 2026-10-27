/** Shared transport fixture for core catalog and plugin integration tests. */
import type { Context } from 'hono';
import { expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import type { DataCatalog } from '@greenhouse/types/hub-context';
import { buildMcpServer, composeMcpContext } from '../../routes/mcp.js';
import { identityFromOAuthScopes } from '../../agent-runtime/mcp-auth.js';
import { memberMcpToolIds } from '../../agent-runtime/mcp-tool-visibility.js';
import { humanActor } from '../../plugin-host/actor.js';
import { buildDataCatalog } from '../catalog.js';

export async function webCatalog(db: DatabaseProvider, user: UserRow): Promise<DataCatalog> {
  return buildDataCatalog({
    db,
    actor: humanActor(user),
    reachable: await memberMcpToolIds(user.id, user.role as 'team' | 'super'),
  });
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
