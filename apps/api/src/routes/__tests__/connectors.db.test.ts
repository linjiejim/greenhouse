/**
 * Connector routes against a real MCP fixture server and the real database:
 * admin team connectors (none / shared key / per-member key / OAuth), secrets
 * write-only, an address change dropping every member credential, the directory
 * reloaded after each write (including when the installer has no connection),
 * personal connectors (no private network, no shared credential, owner only),
 * and the OAuth round trip through the public callback and the member-only
 * finish.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppEnv } from '../../app-env.js';
import adminConnectorRoutes from '../admin-connectors.js';
import { connectorOAuthCallbackRoutes, memberConnectorRoutes } from '../connectors.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { _setConnectorDirectory, getConnectorDirectory } from '../../connectors/directory.js';
import { startMcpTestServer, type McpTestServer } from '../../connectors/__tests__/fixture-server.js';

vi.setConfig({ testTimeout: 20_000 });
process.env.PROVIDER_TOKEN_ENCRYPTION_KEY ??= 'a'.repeat(64);

let open: McpTestServer;
let keyed: McpTestServer;
let oauth: McpTestServer;
let db: DatabaseProvider;
let admin: UserRow;
let alice: UserRow;
let bob: UserRow;

beforeAll(async () => {
  open = await startMcpTestServer();
  keyed = await startMcpTestServer({ apiKey: { value: 'member-key-1', header: 'x-api-key' } });
  oauth = await startMcpTestServer({ oauth: {} });
});
afterAll(async () => {
  await Promise.all([open.close(), keyed.close(), oauth.close()]);
});

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const tag = randomBytes(4).toString('hex');
  admin = await createInternalTestUser(db, { email: `cadmin_${tag}@example.test`, role: 'super' });
  alice = await createInternalTestUser(db, { email: `calice_${tag}@example.test` });
  bob = await createInternalTestUser(db, { email: `cbob_${tag}@example.test` });
  _setConnectorDirectory([]);
});

afterEach(async () => {
  await db.close();
  _resetProvider();
});

function app(actor: UserRow) {
  return new Hono<AppEnv>()
    .route('/api/connectors', connectorOAuthCallbackRoutes)
    .use('*', async (c, next) => {
      c.set('user', { id: actor.id, role: actor.role } as never);
      await next();
    })
    .route('/api/admin/connectors', adminConnectorRoutes)
    .route('/api/me/connectors', memberConnectorRoutes);
}

const send = (method: string, body?: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const slug = () => `c${randomBytes(3).toString('hex')}`;

describe('team connectors (admin)', () => {
  it('a public connector lists its tools on creation and joins the directory; read-only tools default on', async () => {
    const res = await app(admin).request(
      '/api/admin/connectors',
      send('POST', { slug: slug(), name: 'Desk', url: open.url }),
    );
    expect(res.status).toBe(201);
    const view = (await res.json()) as { id: string; tools: Array<{ name: string; enabled: boolean; kind: string }> };
    expect(view.tools.find((t) => t.name === 'lookup_order')).toMatchObject({ enabled: true, kind: 'read' });
    expect(view.tools.find((t) => t.name === 'create_ticket')).toMatchObject({ enabled: false, kind: 'write' });
    expect(view.tools.find((t) => t.name === 'delete_ticket')).toMatchObject({ enabled: false, kind: 'destructive' });
    const entry = getConnectorDirectory().find((c) => c.id === view.id);
    expect(entry?.tools.map((t) => t.name).sort()).toEqual(['chart_png', 'leaky', 'lookup_order', 'whoami']);
  });

  it('a shared key is write-only and never comes back', async () => {
    const res = await app(admin).request(
      '/api/admin/connectors',
      send('POST', {
        slug: slug(),
        name: 'Keyed',
        url: keyed.url,
        auth_mode: 'shared',
        auth_kind: 'key',
        auth_header: 'x-api-key',
        shared_secret: 'member-key-1',
      }),
    );
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain('member-key-1');
    expect(JSON.parse(text)).toMatchObject({ has_shared_secret: true, last_error: null });
    expect(JSON.parse(text).tools.length).toBe(6);
  });

  it('refuses a private address unless marked internal, and only a team connector can be', async () => {
    const res = await app(admin).request(
      '/api/admin/connectors',
      send('POST', { slug: slug(), name: 'x', url: 'http://10.0.0.5/mcp' }),
    );
    expect(res.status).toBe(400);
    const internal = await app(admin).request(
      '/api/admin/connectors',
      send('POST', { slug: slug(), name: 'x', url: 'http://10.0.0.5/mcp', private_network: true }),
    );
    expect(internal.status).toBe(201);
  }, 60_000); // the internal address is unreachable here: creation waits out the connect timeout

  it('a per-member connector joins the directory before anyone connected (the installer has no key)', async () => {
    const res = await app(admin).request(
      '/api/admin/connectors',
      send('POST', {
        slug: slug(),
        name: 'Mine',
        url: keyed.url,
        auth_mode: 'per_member',
        auth_kind: 'key',
        auth_header: 'x-api-key',
      }),
    );
    const view = (await res.json()) as { id: string };
    expect(getConnectorDirectory().some((c) => c.id === view.id)).toBe(true);
  });

  it("changing the address drops every member's credential", async () => {
    const created = (await (
      await app(admin).request(
        '/api/admin/connectors',
        send('POST', {
          slug: slug(),
          name: 'Mine',
          url: keyed.url,
          auth_mode: 'per_member',
          auth_kind: 'key',
          auth_header: 'x-api-key',
        }),
      )
    ).json()) as { id: string };
    const saved = await app(alice).request(
      `/api/me/connectors/${created.id}/key`,
      send('PUT', { key: 'member-key-1' }),
    );
    expect(await saved.json()).toMatchObject({ ok: true, connector: { status: 'connected' } });
    expect(await db.mcpConnectors.getConnection(alice.id, created.id)).toBeDefined();

    // A rename keeps it …
    await app(admin).request(`/api/admin/connectors/${created.id}`, send('PATCH', { name: 'Renamed' }));
    expect(await db.mcpConnectors.getConnection(alice.id, created.id)).toBeDefined();
    // … a new address does not.
    const moved = await app(admin).request(
      `/api/admin/connectors/${created.id}`,
      send('PATCH', { url: open.url.replace('/mcp', '/mcp2') }),
    );
    expect(moved.status).toBe(200);
    expect(await db.mcpConnectors.getConnection(alice.id, created.id)).toBeUndefined();
  });
});

describe('member connections', () => {
  it('a wrong key is stored but reported, and the member view shows the error', async () => {
    const created = (await (
      await app(admin).request(
        '/api/admin/connectors',
        send('POST', {
          slug: slug(),
          name: 'Mine',
          url: keyed.url,
          auth_mode: 'per_member',
          auth_kind: 'key',
          auth_header: 'x-api-key',
        }),
      )
    ).json()) as { id: string };
    const res = await app(bob).request(`/api/me/connectors/${created.id}/key`, send('PUT', { key: 'wrong-key' }));
    const body = (await res.json()) as { ok: boolean; error: string; connector: { status: string } };
    expect(body.ok).toBe(false);
    expect(body.error).not.toContain('wrong-key');
    expect(body.connector.status).toBe('error');
    const list = (await (await app(bob).request('/api/me/connectors')).json()) as {
      team: Array<{ id: string; status: string }>;
    };
    expect(list.team.find((c) => c.id === created.id)?.status).toBe('error');
    // Disconnect removes it.
    await app(bob).request(`/api/me/connectors/${created.id}/connection`, send('DELETE'));
    expect(await db.mcpConnectors.getConnection(bob.id, created.id)).toBeUndefined();
  });
});

describe('personal connectors', () => {
  it('a member adds their own; nobody else sees it; it cannot be shared or internal', async () => {
    const res = await app(alice).request(
      '/api/me/connectors/personal',
      send('POST', { slug: 'notes', name: 'Notes', url: open.url }),
    );
    expect(res.status).toBe(201);
    const view = (await res.json()) as { id: string; handle: string; tools: unknown[] };
    expect(view.handle).toBe('me/notes');
    expect(view.tools.length).toBe(6);
    const mine = (await (await app(alice).request('/api/me/connectors')).json()) as { personal: Array<{ id: string }> };
    expect(mine.personal.map((c) => c.id)).toContain(view.id);
    const theirs = (await (await app(bob).request('/api/me/connectors')).json()) as { personal: Array<{ id: string }> };
    expect(theirs.personal.map((c) => c.id)).not.toContain(view.id);
    expect((await app(bob).request(`/api/me/connectors/personal/${view.id}`, send('DELETE'))).status).toBe(404);

    for (const bad of [
      { slug: 'a1', name: 'x', url: 'http://10.0.0.5/mcp' },
      { slug: 'a2', name: 'x', url: open.url, private_network: true },
      {
        slug: 'a3',
        name: 'x',
        url: open.url,
        auth_mode: 'shared',
        auth_kind: 'key',
        auth_header: 'x',
        shared_secret: 'k',
      },
    ]) {
      expect((await app(alice).request('/api/me/connectors/personal', send('POST', bad))).status).toBe(400);
    }
  });
});

describe('OAuth through the routes', () => {
  async function oauthConnector() {
    const res = await app(admin).request(
      '/api/admin/connectors',
      send('POST', { slug: slug(), name: 'Desk', url: oauth.url, auth_mode: 'per_member', auth_kind: 'oauth' }),
    );
    return (await res.json()) as { id: string };
  }

  async function startAndAuthorize(actor: UserRow, connectorId: string, client: 'web' | 'mobile' = 'web') {
    const started = await app(actor).request(`/api/me/connectors/${connectorId}/oauth/start`, send('POST', { client }));
    const { authorize_url } = (await started.json()) as { authorize_url: string };
    const res = await fetch(authorize_url, { redirect: 'manual' });
    const back = new URL(res.headers.get('location')!);
    expect(back.pathname).toBe('/api/connectors/oauth/callback');
    // The public callback only redirects back to the app.
    const callback = await app(actor).request(`${back.pathname}${back.search}`);
    expect(callback.status).toBe(302);
    return new URL(callback.headers.get('location')!.replace('#/', ''));
  }

  it('callback → web finish page; finish by someone else is refused; finish by the starter connects', async () => {
    const { id } = await oauthConnector();
    const finish = await startAndAuthorize(alice, id);
    expect(finish.pathname).toBe('/connectors/oauth-finish');
    const code = finish.searchParams.get('code');
    const state = finish.searchParams.get('state');

    const stolen = await app(bob).request('/api/me/connectors/oauth/finish', send('POST', { code, state }));
    expect(stolen.status).toBe(403);
    expect(await db.mcpConnectors.getConnection(bob.id, id)).toBeUndefined();

    const done = await app(alice).request('/api/me/connectors/oauth/finish', send('POST', { code, state }));
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ connector_id: id, connector: { status: 'connected', tool_count: 4 } });
  });

  it('a sign-in started on the phone comes back to the app scheme', async () => {
    const { id } = await oauthConnector();
    const started = await app(alice).request(
      `/api/me/connectors/${id}/oauth/start`,
      send('POST', { client: 'mobile' }),
    );
    const { authorize_url } = (await started.json()) as { authorize_url: string };
    const res = await fetch(authorize_url, { redirect: 'manual' });
    const back = new URL(res.headers.get('location')!);
    const callback = await app(alice).request(`${back.pathname}${back.search}`);
    expect(callback.headers.get('location')).toMatch(/^greenhouse:\/\/connectors\/oauth-finish\?code=/);
  });

  it('a callback with a forged state goes back to the web app with an error and writes nothing', async () => {
    const callback = await app(alice).request('/api/connectors/oauth/callback?code=x&state=forged');
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toContain('#/connectors/oauth-finish?error=invalid_state');
  });
});
