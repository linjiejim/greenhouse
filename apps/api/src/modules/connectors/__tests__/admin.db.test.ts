/** 管理 → 连接器: install, edit, refresh, test and remove connectors against local MCP servers. */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { auditEvents, connections, connectors, getDb } from '@greenhouse/db';
import { catalogEntry, connectorApp } from './setup.js';
import { startFakeMcpServer, type FakeMcpServer } from './fake-mcp-server.js';

const SHARED = 'shared-token-0001';
const servers: FakeMcpServer[] = [];
const fake = async (options: Parameters<typeof startFakeMcpServer>[0] = {}) => {
  const server = await startFakeMcpServer(options);
  servers.push(server);
  return server;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const audits = (resourceId: string) =>
  getDb().select().from(auditEvents).where(eq(auditEvents.resourceId, resourceId)).orderBy(auditEvents.id);

describe('installing a connector', () => {
  it('from a URL with a shared key: tools listed at once, the key sealed and never returned', async () => {
    const server = await fake({ token: SHARED });
    const { call, lin, admin, install } = await connectorApp();
    const body = { slug: 'desk', name: 'Order desk', url: server.url, auth_mode: 'shared', auth_prefix: 'Bearer ' };

    expect((await call('POST', '/api/admin/connectors', { token: lin.token, body })).status).toBe(403);
    const created = await install({ ...body, shared_key: SHARED });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      slug: 'desk',
      auth_mode: 'shared',
      auth_header: 'Authorization',
      shared_key_set: true,
      last_error: null,
      enabled: true,
      connection_count: 0,
    });
    expect(created.body.tools).toHaveLength(8);
    expect(created.body.tools.find((tool: { name: string }) => tool.name === 'lookup_order')).toMatchObject({
      declared_read_only: true,
      read_only: true,
      allowed: true,
    });
    expect(JSON.stringify(created.body)).not.toContain(SHARED);
    expect(server.requests.every((request) => request.authorization === `Bearer ${SHARED}`)).toBe(true);

    const [row] = await getDb().select().from(connectors).where(eq(connectors.id, created.body.id));
    expect(row!.authEnc).toMatch(/^k1:/);
    expect(row!.authEnc).not.toContain(SHARED);
    const [entry] = await audits(created.body.id);
    expect(entry).toMatchObject({ action: 'connector.create', actorId: admin.id, summary: 'desk shared' });

    const listed = await call('GET', '/api/admin/connectors', { token: admin.token });
    expect(listed.body.items.map((item: { slug: string }) => item.slug)).toEqual(['desk']);
    expect(JSON.stringify(listed.body)).not.toContain(SHARED);
    expect((await install({ ...body, shared_key: SHARED })).body.error.code).toBe('connector_slug_taken');
  });

  it('keeps a server it cannot reach and says why; a new key lists again; refresh and test', async () => {
    const server = await fake({ token: SHARED });
    const { call, admin, install } = await connectorApp();
    const created = await install({
      slug: 'desk',
      name: 'Desk',
      url: server.url,
      auth_mode: 'shared',
      shared_key: 'wrong',
    });
    expect(created.status).toBe(201);
    expect(created.body.tools).toEqual([]);
    expect(created.body.last_error).toMatch(/refused the credential/);
    expect(created.body.last_error).not.toContain('wrong');

    const fixed = await call('PATCH', `/api/admin/connectors/${created.body.id}`, {
      token: admin.token,
      body: { shared_key: SHARED, auth_prefix: 'Bearer ' },
    });
    expect(fixed.body).toMatchObject({ last_error: null });
    expect(fixed.body.tools).toHaveLength(8);

    const tested = await call('POST', `/api/admin/connectors/${created.body.id}/test`, { token: admin.token });
    expect(tested.body).toMatchObject({ ok: true, tool_count: 8, error: null });
    const refreshed = await call('POST', `/api/admin/connectors/${created.body.id}/refresh`, { token: admin.token });
    expect(refreshed.body.tools_refreshed_at).toBeTruthy();
    expect((await audits(created.body.id)).map((entry) => entry.action)).toEqual([
      'connector.create',
      'connector.update',
      'connector.refresh',
    ]);
    const [update] = (await audits(created.body.id)).filter((entry) => entry.action === 'connector.update');
    expect(update!.summary).toBe('auth_prefix, shared_key');
  });

  it('applies the allowlist and vouched read-only tools, and turns off', async () => {
    const server = await fake();
    const { call, admin, install } = await connectorApp();
    const created = await install({ slug: 'desk', name: 'Desk', url: server.url });
    const updated = await call('PATCH', `/api/admin/connectors/${created.body.id}`, {
      token: admin.token,
      body: {
        allowed_tools: ['lookup_order', 'search_docs', 'drop_table'],
        read_only_tools: ['search_docs', 'drop_table'],
      },
    });
    const flags = Object.fromEntries(
      updated.body.tools.map((tool: { name: string; allowed: boolean; read_only: boolean }) => [
        tool.name,
        [tool.allowed, tool.read_only],
      ]),
    );
    expect(flags).toMatchObject({
      lookup_order: [true, true],
      search_docs: [true, true],
      // The server calls it destructive: vouching does not make it read-only.
      drop_table: [true, false],
      create_ticket: [false, false],
    });
    const off = await call('PATCH', `/api/admin/connectors/${created.body.id}`, {
      token: admin.token,
      body: { enabled: false },
    });
    expect(off.body.enabled).toBe(false);
    expect((await audits(created.body.id)).at(-1)!.action).toBe('connector.disable');
  });

  it('refuses addresses and configurations that cannot hold', async () => {
    const server = await fake();
    const { install } = await connectorApp();
    const base = { slug: 'desk', name: 'Desk', url: server.url };
    const refused = async (body: Record<string, unknown>) => {
      const answer = await install({ ...base, ...body });
      expect(answer.status, JSON.stringify(body)).toBe(400);
      return answer.body.error.message as string;
    };
    expect(await refused({ url: 'http://10.0.0.1/mcp' })).toMatch(/localhost/);
    expect(await refused({ url: 'https://user:pw@mcp.example.com/mcp' })).toMatch(/credentials/);
    expect(await refused({ auth_mode: 'shared' })).toMatch(/needs the key/);
    expect(await refused({ auth_mode: 'oauth', shared_key: 'x1' })).toMatch(/no shared key/);
    expect(await refused({ auth_mode: 'per_member', auth_header: 'Content-Type' })).toMatch(
      /belongs to the connection/,
    );
    expect(await refused({ auth_mode: 'none', oauth_client_id: 'abc' })).toMatch(/OAuth client/);
    expect(await refused({ key_help_url: 'http://help.example.com' })).toMatch(/https/);
    expect(await refused({ slug: 'Bad Slug' })).toBeTruthy();
    expect(await refused({ shared_key: 'two\nlines', auth_mode: 'shared' })).toBeTruthy();
  });

  it('a new address or auth mode disconnects every member; removing takes their connections along', async () => {
    const server = await fake({ apiKey: { value: 'member-key-1', header: 'X-Api-Key' } });
    const other = await fake({ apiKey: { value: 'member-key-1', header: 'X-Api-Key' } });
    const { call, admin, lin, install } = await connectorApp();
    const created = await install({
      slug: 'desk',
      name: 'Desk',
      url: server.url,
      auth_mode: 'per_member',
      auth_header: 'X-Api-Key',
      key_help: 'Your desk key',
    });
    expect(created.body).toMatchObject({ tools: [], last_error: null, key_help: 'Your desk key' });
    const connected = await call('POST', '/api/me/connections', {
      token: lin.token,
      body: { connector_id: created.body.id, key: 'member-key-1' },
    });
    expect(connected.status).toBe(201);
    // The first member's connection listed the tools nobody could list before.
    expect((await call('GET', `/api/admin/connectors/${created.body.id}`, { token: admin.token })).body).toMatchObject({
      connection_count: 1,
      tools: expect.arrayContaining([expect.objectContaining({ name: 'lookup_order' })]),
    });

    const moved = await call('PATCH', `/api/admin/connectors/${created.body.id}`, {
      token: admin.token,
      body: { url: other.url },
    });
    expect(moved.body).toMatchObject({ connection_count: 0, tools: [] });
    expect((await audits(created.body.id)).at(-1)!.summary).toBe('url; members disconnected');
    expect(
      await getDb()
        .select()
        .from(connections)
        .where(and(eq(connections.connectorId, created.body.id))),
    ).toHaveLength(0);

    await call('POST', '/api/me/connections', {
      token: lin.token,
      body: { connector_id: created.body.id, key: 'member-key-1' },
    });
    expect((await call('DELETE', `/api/admin/connectors/${created.body.id}`, { token: admin.token })).status).toBe(204);
    expect(await getDb().select().from(connections)).toHaveLength(0);
    expect((await audits(created.body.id)).at(-1)).toMatchObject({ action: 'connector.delete', summary: 'desk' });
    expect((await call('GET', `/api/admin/connectors/${created.body.id}`, { token: admin.token })).status).toBe(404);
  });

  it('refresh needs the admin’s own connection for a connector that works with each member’s account', async () => {
    const server = await fake({ oauth: {} });
    const { call, admin, install } = await connectorApp();
    const created = await install({ slug: 'desk', name: 'Desk', url: server.url, auth_mode: 'oauth' });
    expect(created.body).toMatchObject({ tools: [], last_error: null });
    const refreshed = await call('POST', `/api/admin/connectors/${created.body.id}/refresh`, { token: admin.token });
    expect(refreshed.status).toBe(409);
    expect(refreshed.body.error.code).toBe('connection_required');
  });
});

describe('the catalog, the Registry and probing', () => {
  it('installs a catalog entry with what it vouches for, and shows what is installed', async () => {
    const server = await fake();
    const { call, admin, install } = await connectorApp({
      connectors: { catalog: () => [catalogEntry(server.url, { read_only_tools: ['search_docs'] })] },
    });
    const before = await call('GET', '/api/admin/connectors/catalog', { token: admin.token });
    expect(before.body.items).toEqual([expect.objectContaining({ id: 'test.example/desk', installed_slug: null })]);

    const created = await install({ catalog_id: 'test.example/desk' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ slug: 'desk', name: 'Order desk', catalog_id: 'test.example/desk' });
    expect(created.body.tools.find((tool: { name: string }) => tool.name === 'search_docs').read_only).toBe(true);
    expect((await install({ catalog_id: 'test.example/desk' })).status).toBe(409);
    expect((await install({ catalog_id: 'test.example/desk', slug: 'desk2' })).status).toBe(201);
    expect((await install({ catalog_id: 'nope/nope' })).status).toBe(404);

    const after = await call('GET', '/api/admin/connectors/catalog', { token: admin.token });
    expect(after.body.items[0].installed_slug).toMatch(/^desk/);
  });

  it('searches the Registry once per query, and says when it cannot', async () => {
    let hits = 0;
    const registry = createServer((request, response) => {
      hits++;
      const query = new URL(request.url!, 'http://x').searchParams.get('search');
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          servers: [
            {
              server: {
                name: `io.example/${query}`,
                version: '1.2.0',
                description: 'An example',
                remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
              },
              _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } },
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
    const registryUrl = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
    try {
      const { call, admin } = await connectorApp({ connectors: { registryUrl } });
      const first = await call('GET', '/api/admin/connectors/registry?q=Notes', { token: admin.token });
      expect(first.body.items).toEqual([
        expect.objectContaining({
          name: 'io.example/notes',
          remotes: [expect.objectContaining({ transport: 'streamable_http' })],
        }),
      ]);
      await call('GET', '/api/admin/connectors/registry?q=notes', { token: admin.token });
      expect(hits).toBe(1);
    } finally {
      registry.closeAllConnections();
      await new Promise((resolve) => registry.close(resolve));
    }
    const { call, admin } = await connectorApp({ connectors: { registryUrl } });
    const down = await call('GET', '/api/admin/connectors/registry?q=x', { token: admin.token });
    expect(down.status).toBe(502);
    expect(down.body.error.code).toBe('registry_unavailable');
  });

  it('tells what an address asks for: nothing, a key or a sign-in', async () => {
    const open = await fake();
    const keyed = await fake({ token: SHARED });
    const signIn = await fake({ oauth: {} });
    const { call, admin } = await connectorApp();
    const probe = async (url: string) =>
      (await call('POST', '/api/admin/connectors/probe', { token: admin.token, body: { url } })).body;
    expect(await probe(open.url)).toMatchObject({ auth: 'none', tool_count: 8 });
    expect(await probe(keyed.url)).toMatchObject({ auth: 'key' });
    expect(await probe(signIn.url)).toMatchObject({ auth: 'oauth', dynamic_registration: true, scopes: ['tickets'] });
    expect(
      (await call('POST', '/api/admin/connectors/probe', { token: admin.token, body: { url: 'http://10.1.1.1/x' } }))
        .status,
    ).toBe(400);
  });
});
