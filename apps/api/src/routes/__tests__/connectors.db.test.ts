/**
 * /api/connectors against real PostgreSQL and real MCP servers (spec
 * 20261009-mcp-connectors): a member's own key (verified, stored encrypted,
 * isolated per member), a member's OAuth sign-in end to end through the public
 * callback (the browser hop played by fetch), and the gate on the `mcp_call`
 * grant.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.TOKEN_SIGNING_KEY = process.env.TOKEN_SIGNING_KEY ?? '11'.repeat(32);
process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = process.env.PROVIDER_TOKEN_ENCRYPTION_KEY ?? '22'.repeat(32);

import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppEnv } from '../../app-env.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { getMcpDirectory, refreshMcpDirectory } from '../../mcp-client/directory.js';
import { startMcpTestServer, type McpTestServer } from '../../mcp-client/__tests__/fixture-server.js';
import connectorRoutes from '../connectors.js';

let db: DatabaseProvider;
let alice: UserRow;
let bob: UserRow;
let outsider: UserRow;
let keyed: McpTestServer;
let oauth: McpTestServer;

function app() {
  const users = new Map([alice, bob, outsider].map((u) => [u.id, u]));
  const hono = new Hono<AppEnv>();
  // Stand-in for the central Bearer middleware: a known header → that user;
  // no header → anonymous (the public callback must work without one).
  hono.use('*', async (c, next) => {
    const user = users.get(c.req.header('x-test-user') ?? '');
    if (user) c.set('user', { id: user.id, role: user.role as 'team' | 'super' });
    return next();
  });
  hono.route('/api/connectors', connectorRoutes);
  return hono;
}

async function call(as: UserRow | null, method: string, path: string, body?: unknown) {
  const res = await app().request(`/api/connectors${path}`, {
    method,
    headers: {
      ...(as ? { 'x-test-user': as.id } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {
    // HTML (the callback page)
  }
  return { status: res.status, json, raw: text };
}

async function installServer(input: Parameters<DatabaseProvider['mcpServers']['create']>[0]) {
  const row = await db.mcpServers.create(input);
  if (!row) throw new Error('slug taken');
  await refreshMcpDirectory(db);
  return row;
}

const uid = () => Math.floor(Math.random() * 1e9).toString(36);

beforeAll(async () => {
  keyed = await startMcpTestServer({ apiKey: { value: 'alice-key', query: 'key' } });
  oauth = await startMcpTestServer({ oauth: {} });
});

afterAll(async () => {
  await Promise.all([keyed.close(), oauth.close()]);
});

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const stamp = `${Date.now()}-${Math.random()}`;
  alice = await createInternalTestUser(db, { email: `conn-alice-${stamp}@test.local`, role: 'team' });
  bob = await createInternalTestUser(db, { email: `conn-bob-${stamp}@test.local`, role: 'team' });
  outsider = await createInternalTestUser(db, { email: `conn-out-${stamp}@test.local`, role: 'team' });
  for (const user of [alice, bob]) await db.userTools.setTools(user.id, ['mcp_call'], user.id);
});

describe("/api/connectors — a member's own key", () => {
  it('without the mcp_call grant there is nothing to connect', async () => {
    const server = await installServer({
      slug: `maps-${uid()}`,
      name: 'Maps',
      url: keyed.url,
      auth_mode: 'per_user',
      auth_query_param: 'key',
    });
    expect((await call(outsider, 'GET', '')).json).toEqual({ enabled: false, connectors: [] });
    expect((await call(outsider, 'PUT', `/${server.id}/key`, { key: 'alice-key' })).status).toBe(403);
  });

  it('verifies the key, stores it encrypted for that member only, and lists the tools it unlocked', async () => {
    const server = await installServer({
      slug: `maps-${uid()}`,
      name: 'Maps',
      url: keyed.url,
      auth_mode: 'per_user',
      auth_query_param: 'key',
    });
    const before = (await call(alice, 'GET', '')).json.connectors.find((c: { id: number }) => c.id === server.id);
    expect(before).toMatchObject({ status: 'not_connected', tool_count: 0 });

    const wrong = await call(alice, 'PUT', `/${server.id}/key`, { key: 'not-her-key' });
    expect(wrong.status).toBe(400);
    expect(wrong.raw).not.toContain('not-her-key');

    const saved = await call(alice, 'PUT', `/${server.id}/key`, { key: 'alice-key' });
    expect(saved.status).toBe(200);
    expect(saved.json.connector).toMatchObject({ status: 'connected', tool_count: 5 });
    expect(saved.raw).not.toContain('alice-key');

    const row = await db.mcpServers.getConnection(alice.id, server.id);
    expect(row?.provider_credential).toBeTruthy();
    expect(row?.provider_credential).not.toContain('alice-key');
    // The first connection listed the tools for everyone.
    expect(getMcpDirectory().find((s) => s.id === server.id)?.tools).toHaveLength(5);

    // Bob sees the connector — but not Alice's key.
    const bobView = (await call(bob, 'GET', '')).json.connectors.find((c: { id: number }) => c.id === server.id);
    expect(bobView.status).toBe('not_connected');

    expect((await call(alice, 'POST', `/${server.id}/test`)).json).toMatchObject({ ok: true, tool_count: 5 });
    expect((await call(bob, 'POST', `/${server.id}/test`)).json).toMatchObject({ ok: false, status: 'not_connected' });

    // Bob disconnecting touches only his own (absent) connection.
    expect((await call(bob, 'DELETE', `/${server.id}`)).json).toEqual({ ok: true, removed: false });
    expect(await db.mcpServers.getConnection(alice.id, server.id)).toBeTruthy();
    expect((await call(alice, 'DELETE', `/${server.id}`)).json).toEqual({ ok: true, removed: true });
    expect(await db.mcpServers.getConnection(alice.id, server.id)).toBeUndefined();
  });

  it('refuses a key for a connector that does not take one', async () => {
    const server = await installServer({ slug: `open-${uid()}`, name: 'Open', url: keyed.url, auth_mode: 'none' });
    expect((await call(alice, 'PUT', `/${server.id}/key`, { key: 'x' })).status).toBe(400);
    expect((await call(alice, 'POST', `/${server.id}/authorize`)).status).toBe(400);
    expect((await call(alice, 'PUT', '/999999999/key', { key: 'x' })).status).toBe(404);
  });
});

describe("/api/connectors — a member's OAuth sign-in", () => {
  it('authorize → provider → public callback → connected; tools listed; the sign-in is hers alone', async () => {
    oauth.oauth!.nextSubject = 'alice@desk';
    const server = await installServer({
      slug: `desk-${uid()}`,
      name: 'Order desk',
      url: oauth.url,
      auth_mode: 'oauth',
    });

    const started = await call(alice, 'POST', `/${server.id}/authorize`);
    expect(started.status).toBe(200);
    const authorizeUrl = new URL(started.json.url as string);
    expect(authorizeUrl.origin).toBe(oauth.origin);
    // In this test the request origin is http://localhost (no PUBLIC_BASE_URL).
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe('http://localhost/api/connectors/oauth/callback');

    // The browser: the provider approves and redirects back with code + state.
    const consent = await fetch(authorizeUrl, { redirect: 'manual' });
    const back = new URL(consent.headers.get('location')!);
    const callback = await call(null, 'GET', `/oauth/callback${back.search}`);
    expect(callback.status).toBe(200);
    expect(callback.raw).toContain('data-ok="true"');
    expect(callback.raw).toContain('Connected to Order desk');
    expect(callback.raw).not.toMatch(/at_[A-Za-z0-9_-]{10}/); // no token in the page

    const mine = (await call(alice, 'GET', '')).json.connectors.find((c: { id: number }) => c.id === server.id);
    expect(mine).toMatchObject({ status: 'connected', tool_count: 5 });
    expect(getMcpDirectory().find((s) => s.id === server.id)?.auth_mode).toBe('oauth');

    const bobs = (await call(bob, 'GET', '')).json.connectors.find((c: { id: number }) => c.id === server.id);
    expect(bobs.status).toBe('not_connected');

    // Replaying the same callback (the code is spent) changes nothing and says so.
    const replay = await call(null, 'GET', `/oauth/callback${back.search}`);
    expect(replay.status).toBe(400);
    expect(replay.raw).toContain('data-ok="false"');

    // Disconnect revokes at the provider, then forgets the sign-in.
    const revokedBefore = oauth.oauth!.revoked.length;
    expect((await call(alice, 'DELETE', `/${server.id}`)).json).toEqual({ ok: true, removed: true });
    expect(oauth.oauth!.revoked.length).toBe(revokedBefore + 1);
    const after = (await call(alice, 'GET', '')).json.connectors.find((c: { id: number }) => c.id === server.id);
    expect(after.status).toBe('not_connected');
  });

  it('the callback page refuses a forged state and a declined consent', async () => {
    const forged = await call(null, 'GET', '/oauth/callback?code=abc&state=not-a-real-state');
    expect(forged.status).toBe(400);
    expect(forged.raw).toContain('invalid or expired');
    const declined = await call(null, 'GET', '/oauth/callback?error=access_denied&error_description=User%20said%20no');
    expect(declined.status).toBe(400);
    expect(declined.raw).toContain('access_denied');
    // The page escapes what the provider sent.
    const hostile = await call(null, 'GET', '/oauth/callback?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    expect(hostile.raw).not.toContain('<script>alert(1)</script>');
  });

  it('a member without the grant cannot start a sign-in', async () => {
    const server = await installServer({
      slug: `desk-${uid()}`,
      name: 'Order desk',
      url: oauth.url,
      auth_mode: 'oauth',
    });
    expect((await call(outsider, 'POST', `/${server.id}/authorize`)).status).toBe(403);
  });

  it('the client-id metadata document exists only behind an https public address', async () => {
    const saved = process.env.PUBLIC_BASE_URL;
    try {
      delete process.env.PUBLIC_BASE_URL;
      expect((await call(null, 'GET', '/oauth/client-metadata.json')).status).toBe(404);
      process.env.PUBLIC_BASE_URL = 'https://greenhouse.example.com';
      const doc = await call(null, 'GET', '/oauth/client-metadata.json');
      expect(doc.status).toBe(200);
      expect(doc.json).toMatchObject({
        client_id: 'https://greenhouse.example.com/api/connectors/oauth/client-metadata.json',
        redirect_uris: ['https://greenhouse.example.com/api/connectors/oauth/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
      });
    } finally {
      if (saved === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = saved;
    }
  });
});
