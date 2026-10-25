/**
 * mcp_call over /api/mcp (group `connectors`), driven through the real MCP
 * server (in-memory transport) against a real MCP fixture server.
 *
 * Pinned here: listed only with the group and at least one connector, with
 * the connector list in its description and the cautious annotations; reads
 * work with mcp:read; remote writes need mcp:write and, on a team credential,
 * the connector's allow_external_writes; a new connector shows up on the next
 * request (the context cache keys on the directory version).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { buildMcpServer, composeMcpContext } from '../mcp.js';
import { identityFromOAuthScopes } from '../../agent-runtime/mcp-auth.js';
import { _setConnectorDirectory } from '../../connectors/directory.js';
import { createConnector, updateConnector } from '../../connectors/manage.js';
import { startMcpTestServer, type McpTestServer } from '../../connectors/__tests__/fixture-server.js';

vi.setConfig({ testTimeout: 20_000 });
process.env.PROVIDER_TOKEN_ENCRYPTION_KEY ??= 'a'.repeat(64);

let fixture: McpTestServer;
let db: DatabaseProvider;
let admin: UserRow;
let member: UserRow;
let clientId: string;

beforeAll(async () => {
  fixture = await startMcpTestServer();
});
afterAll(async () => {
  await fixture.close();
});

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const tag = randomBytes(4).toString('hex');
  admin = await createInternalTestUser(db, { email: `mxadmin_${tag}@example.test`, role: 'super' });
  member = await createInternalTestUser(db, { email: `mxmember_${tag}@example.test` });
  clientId = `client-${tag}`;
  await db.platformOAuth.registerClient({
    id: clientId,
    client_name: 'Codex',
    redirect_uris: [],
    created_by: member.id,
  });
  _setConnectorDirectory([]);
  fixture.tickets.length = 0;
});
afterEach(async () => {
  await db.close();
  _resetProvider();
});

async function connect(scopes: string[]) {
  const identity = identityFromOAuthScopes({ id: member.id, role: 'team' }, scopes as never);
  const ctx = await composeMcpContext(identity, {});
  const values: Record<string, unknown> = {
    agentIdentity: identity,
    oauthClientId: clientId,
    oauthAuthMethod: 'oauth',
    oauthScopes: scopes,
  };
  const c = {
    get: (key: string) => values[key],
    req: { method: 'POST', header: () => undefined },
  } as unknown as Context;
  const server = buildMcpServer(c, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

type CallResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
const call = async (client: Client, args: Record<string, unknown>) =>
  (await client.callTool({ name: 'mcp_call', arguments: args })) as CallResult;

async function desk() {
  const actor = { userId: admin.id, role: admin.role };
  const row = await createConnector(db, actor, 'team', {
    slug: `d${randomBytes(3).toString('hex')}`,
    name: 'Desk',
    url: fixture.url,
  });
  return updateConnector(db, actor, row, { tool_policy: { create_ticket: 'on' } });
}

describe('mcp_call over /api/mcp', () => {
  it('is not listed without the connectors group, nor before any connector exists', async () => {
    const withoutGroup = await connect(['mcp:read']);
    expect((await withoutGroup.listTools()).tools.map((t) => t.name)).not.toContain('mcp_call');
    const noConnectors = await connect(['mcp:read', 'mcp:connectors']);
    expect((await noConnectors.listTools()).tools.map((t) => t.name)).not.toContain('mcp_call');
  });

  it('lists the connectors in its description (picked up on the next request) and runs reads', async () => {
    await connect(['mcp:read', 'mcp:connectors']); // warm the context cache
    const row = await desk();
    const client = await connect(['mcp:read', 'mcp:connectors']);
    const listed = (await client.listTools()).tools.find((t) => t.name === 'mcp_call');
    expect(listed?.description).toContain(`- ${row.slug}`);
    expect(listed?.description).toContain('lookup_order [只读]');
    // Without mcp:write a write is not even offered.
    expect(listed?.description).not.toContain('create_ticket');
    expect(listed?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });

    const read = await call(client, {
      action: 'call',
      connector: row.slug,
      tool: 'lookup_order',
      arguments: { order_id: '9' },
    });
    expect(read.isError).toBeFalsy();
    expect(read.content[0]!.text).toContain('shipped on 2026-10-01');
  });

  it('writes need mcp:write, and a team credential also needs allow_external_writes', async () => {
    const row = await desk();
    const write = { action: 'call', connector: row.slug, tool: 'create_ticket', arguments: { title: 'From Codex' } };
    expect((await call(await connect(['mcp:read', 'mcp:connectors']), write)).isError).toBe(true);
    expect((await call(await connect(['mcp:read', 'mcp:write', 'mcp:connectors']), write)).isError).toBe(true);
    expect(fixture.tickets).toEqual([]);

    await updateConnector(db, { userId: admin.id, role: admin.role }, row, { allow_external_writes: true });
    const ok = await call(await connect(['mcp:read', 'mcp:write', 'mcp:connectors']), write);
    expect(ok.isError).toBeFalsy();
    expect(fixture.tickets).toEqual(['From Codex']);
    const recorded = JSON.parse(ok.content[0]!.text) as { recorded_as: string };
    const run = await db.runtime.getRun(recorded.recorded_as);
    expect(run?.kind).toBe('connector_write');
    expect((run?.input as { origin: string; client_name: string }).client_name).toBe('Codex');
  });
});
