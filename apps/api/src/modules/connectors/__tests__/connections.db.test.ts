/** 设置 → 连接: members connect their own key or account, test it, and disconnect; the OAuth round trip. */

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { auditEvents, connections, connectors, getDb } from '@greenhouse/db';
import { connectorApp } from './setup.js';
import { startFakeMcpServer, type FakeMcpServer } from './fake-mcp-server.js';

const KEY = 'member-key-000111';
const servers: FakeMcpServer[] = [];
const fake = async (options: Parameters<typeof startFakeMcpServer>[0] = {}) => {
  const server = await startFakeMcpServer(options);
  servers.push(server);
  return server;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** Plays the browser: the consent page approves at once and redirects to our callback. */
async function consent(authorizationUrl: string): Promise<string> {
  const response = await fetch(authorizationUrl, { redirect: 'manual' });
  expect(response.status).toBe(302);
  return response.headers.get('location')!;
}

/** The web app's side: read what the callback handed over in the hash route. */
function handedOver(location: string): URLSearchParams {
  expect(location.startsWith('http://greenhouse.test/#/settings/connections?')).toBe(true);
  return new URLSearchParams(location.split('?')[1]);
}

async function oauthSetup() {
  const server = await fake({ oauth: {} });
  const app = await connectorApp();
  const created = await app.install({ slug: 'desk', name: 'Order desk', url: server.url, auth_mode: 'oauth' });
  const connectorId = created.body.id as string;
  /** Start, consent, come back through the public callback; returns what the web app would post. */
  const signIn = async (token: string) => {
    const started = await app.call('POST', '/api/me/connections/oauth/start', {
      token,
      body: { connector_id: connectorId },
    });
    expect(started.status).toBe(200);
    const callback = await consent(started.body.authorization_url);
    const back = await app.app.request(callback.replace('http://greenhouse.test', ''));
    expect(back.status).toBe(302);
    const params = handedOver(back.headers.get('location')!);
    return { state: params.get('oauth_state')!, code: params.get('oauth_code')!, connector: params.get('connector') };
  };
  const finish = (token: string, handed: { state: string; code: string }) =>
    app.call('POST', '/api/me/connections/oauth/finish', { token, body: { state: handed.state, code: handed.code } });
  return { ...app, server, connectorId, signIn, finish };
}

describe('a member’s own key', () => {
  it('is checked before it is kept, sealed, used where the connector says, and taken back on disconnect', async () => {
    const server = await fake({ apiKey: { value: KEY, query: 'key' } });
    const { call, services, lin, chen, install } = await connectorApp();
    const created = await install({
      slug: 'desk',
      name: 'Order desk',
      url: server.url,
      auth_mode: 'per_member',
      auth_query_param: 'key',
      key_help: 'The key from your desk profile',
      key_help_url: 'https://desk.example.com/keys',
    });
    const id = created.body.id as string;

    const before = await call('GET', '/api/me/connections', { token: lin.token });
    expect(before.body).toEqual({
      items: [],
      connectors: [
        expect.objectContaining({
          id,
          slug: 'desk',
          auth_mode: 'per_member',
          needs_connection: true,
          key_help: 'The key from your desk profile',
          tool_count: 0,
          builtin: null,
        }),
        expect.objectContaining({ slug: 'mailbox', builtin: 'mailbox', needs_connection: true }),
      ],
    });

    const wrong = await call('POST', '/api/me/connections', {
      token: lin.token,
      body: { connector_id: id, key: 'nope-123' },
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('key_rejected');
    expect(JSON.stringify(wrong.body)).not.toContain('nope-123');

    const connected = await call('POST', '/api/me/connections', {
      token: lin.token,
      body: { connector_id: id, key: ` ${KEY}\n` },
    });
    expect(connected.status).toBe(201);
    expect(connected.body).toMatchObject({
      kind: 'connector',
      connector: { id, slug: 'desk', name: 'Order desk', enabled: true },
      status: 'active',
      last_error: null,
    });
    expect(JSON.stringify(connected.body)).not.toContain(KEY);
    const [row] = await getDb().select().from(connections).where(eq(connections.id, connected.body.id));
    expect(row!.secretsEnc).not.toContain(KEY);

    // A key in the address never reaches the model, even when the server echoes it.
    const echoed = await services.connectors.run(lin.id, id, 'echo_url', {});
    expect(echoed.text).toBe('You called /mcp?key=***');
    // Someone else's key is not mine.
    await expect(services.connectors.run(chen.id, id, 'whoami', {})).rejects.toThrow(/has not connected it/);

    const tested = await call('POST', `/api/me/connections/${connected.body.id}/test`, { token: lin.token });
    expect(tested.body).toMatchObject({ ok: true, tool_count: 8, error: null, connection: { status: 'active' } });
    // Only the owner sees or removes a connection.
    expect((await call('POST', `/api/me/connections/${connected.body.id}/test`, { token: chen.token })).status).toBe(
      404,
    );
    expect((await call('DELETE', `/api/me/connections/${connected.body.id}`, { token: chen.token })).status).toBe(404);

    expect((await call('DELETE', `/api/me/connections/${connected.body.id}`, { token: lin.token })).status).toBe(204);
    expect((await call('GET', '/api/me/connections', { token: lin.token })).body.items).toEqual([]);
    const trail = await getDb().select().from(auditEvents).where(eq(auditEvents.resourceId, connected.body.id));
    expect(trail.map((entry) => [entry.action, entry.actorId, entry.summary])).toEqual([
      ['connection.create', lin.id, 'desk key'],
      ['connection.delete', lin.id, 'connector'],
    ]);
  });

  it('a key the server stops accepting asks the member to renew it', async () => {
    const server = await fake({ apiKey: { value: KEY, header: 'X-Key' } });
    const { call, services, lin, install } = await connectorApp();
    const created = await install({
      slug: 'desk',
      name: 'Desk',
      url: server.url,
      auth_mode: 'per_member',
      auth_header: 'X-Key',
    });
    await call('POST', '/api/me/connections', { token: lin.token, body: { connector_id: created.body.id, key: KEY } });
    // The member rotated the key at the provider: the stored one is refused from now on.
    const rotated = await fake({ apiKey: { value: 'other-key-999', header: 'X-Key' } });
    await getDb().update(connectors).set({ url: rotated.url }).where(eq(connectors.id, created.body.id));

    await expect(services.connectors.run(lin.id, created.body.id, 'whoami', {})).rejects.toThrow(/reconnect it/);
    const mine = await call('GET', '/api/me/connections', { token: lin.token });
    expect(mine.body.items[0]).toMatchObject({ status: 'needs_reauth', last_error: expect.stringMatching(/refused/) });
    expect(await services.connectors.usable(lin.id, { connectors: null, write: true })).toEqual([]);
  });
});

describe('signing in with OAuth', () => {
  it('registers once, sends the member to the provider with PKCE, and only that member finishes', async () => {
    const { call, services, server, connectorId, signIn, finish, lin, chen, admin } = await oauthSetup();
    const started = await call('POST', '/api/me/connections/oauth/start', {
      token: lin.token,
      body: { connector_id: connectorId },
    });
    const url = new URL(started.body.authorization_url);
    expect(`${url.origin}${url.pathname}`).toBe(`${server.origin}/authorize`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe(server.url);
    expect(url.searchParams.get('redirect_uri')).toBe('http://greenhouse.test/api/connectors/oauth/callback');
    expect(url.searchParams.get('scope')).toBe('tickets');
    expect(server.oauth!.clients.size).toBe(1);
    // The state is sealed: it names the member without showing who.
    expect(Buffer.from(url.searchParams.get('state')!, 'base64url').toString()).not.toContain(lin.id);
    const view = await call('GET', `/api/admin/connectors/${connectorId}`, { token: admin.token });
    expect(view.body.oauth_client).toMatchObject({ source: 'dynamic', secret_set: false });

    const handed = await signIn(lin.token);
    expect(handed.connector).toBe(connectorId);
    // Someone else's browser and session cannot finish it, and that does not spend the code.
    const stolen = await finish(chen.token, handed);
    expect(stolen.status).toBe(403);
    expect(stolen.body.error.code).toBe('sign_in_not_yours');

    const finished = await finish(lin.token, handed);
    expect(finished.status).toBe(200);
    expect(finished.body).toMatchObject({ status: 'active', scopes: ['tickets'], connector: { id: connectorId } });
    expect(finished.body.expires_at).toBeTruthy();
    expect(server.oauth!.clients.size).toBe(1);
    const [row] = await getDb().select().from(connections).where(eq(connections.id, finished.body.id));
    expect(row!.secretsEnc).toMatch(/^k1:/);
    expect(row!.secretsEnc).not.toContain('at_');
    // The first sign-in listed the tools nobody could list before.
    expect((await call('GET', `/api/admin/connectors/${connectorId}`, { token: admin.token })).body.tools).toHaveLength(
      8,
    );

    expect((await finish(lin.token, handed)).body.error.code).toBe('sign_in_failed');
    expect((await services.connectors.run(lin.id, connectorId, 'whoami', {})).text).toBe('You are alice');
    // A server that echoes the bearer token cannot pass it on.
    expect((await services.connectors.run(lin.id, connectorId, 'echo_url', {})).text).toBe(
      'You called /mcp as Bearer ***',
    );
    await expect(services.connectors.run(chen.id, connectorId, 'whoami', {})).rejects.toThrow(/has not connected it/);
  });

  it('refreshes an expired token once for parallel calls; a refused refresh asks for a new sign-in', async () => {
    const { call, services, server, connectorId, signIn, finish, lin } = await oauthSetup();
    await finish(lin.token, await signIn(lin.token));
    const before = server.oauth!.refreshCount;
    server.oauth!.expireAccessTokens();
    const [a, b] = await Promise.all([
      services.connectors.run(lin.id, connectorId, 'whoami', {}),
      services.connectors.run(lin.id, connectorId, 'whoami', {}),
    ]);
    expect([a.text, b.text]).toEqual(['You are alice', 'You are alice']);
    expect(server.oauth!.refreshCount).toBe(before + 1);

    server.oauth!.expireAccessTokens();
    server.oauth!.revokeRefreshTokens();
    await expect(services.connectors.run(lin.id, connectorId, 'whoami', {})).rejects.toThrow(/reconnect it/);
    const mine = await call('GET', '/api/me/connections', { token: lin.token });
    expect(mine.body.items[0]).toMatchObject({ status: 'needs_reauth', last_error: expect.any(String) });
    expect(await services.connectors.usable(lin.id, { connectors: null, write: true })).toEqual([]);

    // Signing in again brings it back; disconnecting revokes it at the provider.
    server.oauth!.nextSubject = 'alice2';
    const again = await finish(lin.token, await signIn(lin.token));
    expect(again.body.status).toBe('active');
    expect((await services.connectors.run(lin.id, connectorId, 'whoami', {})).text).toBe('You are alice2');
    const revokedBefore = server.oauth!.revoked.length;
    expect((await call('DELETE', `/api/me/connections/${again.body.id}`, { token: lin.token })).status).toBe(204);
    expect(server.oauth!.revoked.length).toBe(revokedBefore + 1);
  });

  it('the callback carries only what the web app needs, and says why when it failed', async () => {
    const { app, call, connectorId, lin } = await oauthSetup();
    const back = async (query: string) => {
      const response = await app.request(`/api/connectors/oauth/callback?${query}`);
      expect(response.status).toBe(302);
      expect(response.headers.get('cache-control')).toBe('no-store');
      return handedOver(response.headers.get('location')!);
    };
    const denied = await back('error=access_denied&error_description=No+thanks');
    expect([denied.get('oauth_error'), denied.get('oauth_error_description')]).toEqual(['access_denied', 'No thanks']);
    expect((await back('code=abc&state=forged')).get('oauth_error')).toBe('invalid_state');

    const started = await call('POST', '/api/me/connections/oauth/start', {
      token: lin.token,
      body: { connector_id: connectorId },
    });
    const state = new URL(started.body.authorization_url).searchParams.get('state')!;
    const missing = await back(`state=${encodeURIComponent(state)}`);
    expect([missing.get('oauth_error'), missing.get('connector')]).toEqual(['missing_code', connectorId]);
    const handed = await back(`state=${encodeURIComponent(state)}&code=xyz`);
    expect([handed.get('oauth_state'), handed.get('oauth_code'), handed.get('oauth_error')]).toEqual([
      state,
      'xyz',
      null,
    ]);
  });

  it('refuses a sign-in page that is not a web address, and uses a client an admin entered by hand', async () => {
    const server = await fake({ oauth: { dynamicRegistration: false } });
    const { call, admin, lin, install } = await connectorApp();
    const created = await install({ slug: 'desk', name: 'Desk', url: server.url, auth_mode: 'oauth' });
    const start = () =>
      call('POST', '/api/me/connections/oauth/start', { token: lin.token, body: { connector_id: created.body.id } });
    expect((await start()).body.error.code).toBe('sign_in_failed');

    server.oauth!.preRegister('manual-client', 'http://greenhouse.test/api/connectors/oauth/callback');
    const saved = await call('PATCH', `/api/admin/connectors/${created.body.id}`, {
      token: admin.token,
      body: { oauth_client_id: 'manual-client' },
    });
    expect(saved.body.oauth_client).toEqual({ source: 'manual', client_id: 'manual-client', secret_set: false });
    const started = await start();
    expect(new URL(started.body.authorization_url).searchParams.get('client_id')).toBe('manual-client');

    // A server that names somewhere a browser should not go: refused here, whatever the SDK lets through.
    const refusedWith = async (endpoint: string) => {
      server.oauth!.authorizationEndpoint = endpoint;
      await getDb().update(connectors).set({ oauthDiscovery: null }).where(eq(connectors.id, created.body.id));
      const answer = await start();
      expect(answer.status).toBe(502);
      return answer.body.error;
    };
    expect(await refusedWith('http://evil.example.com/authorize')).toMatchObject({
      code: 'sign_in_failed',
      message: expect.stringMatching(/cannot send you to/),
    });
    expect(await refusedWith('javascript:alert(document.cookie)')).toMatchObject({
      code: 'sign_in_failed',
      message: 'Desk could not start a sign-in: its sign-in metadata is not valid',
    });
  });
});
