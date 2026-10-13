import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { OAUTH_SCOPES } from '@greenhouse/contract';
import { auditEvents, getDb, idempotencyKeys, oauthCodes, oauthGrants, oauthTokens } from '@greenhouse/db';
import { createTestApp, TEST_PASSWORD } from '../../../testing.js';
import {
  ISSUER,
  REDIRECT,
  RESOURCE,
  authorize,
  authorizeParams,
  connect,
  mcp,
  pkce,
  postForm,
  queryOf,
  register,
} from './flow.js';

const allScopes = OAUTH_SCOPES.join(' ');

describe('discovery and registration', () => {
  it('publishes the server and resource metadata to any origin, and challenges /api/mcp', async () => {
    const t = createTestApp();
    const origin = { origin: 'https://inspector.example' };
    const server = await t.app.request('/.well-known/oauth-authorization-server', { headers: origin });
    expect(server.headers.get('access-control-allow-origin')).toBe('*');
    expect(await server.json()).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      registration_endpoint: `${ISSUER}/oauth/register`,
      revocation_endpoint: `${ISSUER}/oauth/revoke`,
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [...OAUTH_SCOPES],
    });
    for (const path of ['/.well-known/oauth-protected-resource/api/mcp', '/.well-known/oauth-protected-resource']) {
      expect(await (await t.app.request(path)).json()).toEqual({
        resource: RESOURCE,
        authorization_servers: [ISSUER],
        scopes_supported: [...OAUTH_SCOPES],
        bearer_methods_supported: ['header'],
        resource_name: 'Greenhouse',
      });
    }
    const preflight = await t.app.request('/oauth/token', {
      method: 'OPTIONS',
      headers: { ...origin, 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Mcp-Protocol-Version');

    const anonymous = await mcp(t, null);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/api/mcp", scope="${allScopes}"`,
    );
    const forged = await mcp(t, 'gnh_at_forged-token-value-that-is-long-enough-to-look-real');
    expect(forged.headers.get('www-authenticate')).toContain('error="invalid_token"');
    // The app's own access tokens are not MCP credentials.
    const lin = await t.member();
    expect((await mcp(t, lin.token)).status).toBe(401);
  });

  it('registers public clients only, with redirect URIs that cannot leak a code', async () => {
    const t = createTestApp();
    const ok = await register(t, {
      client_name: 'Claude\u0000 Code',
      token_endpoint_auth_method: 'client_secret_basic',
      grant_types: ['client_credentials'],
      scope: 'agents:read',
    });
    expect(ok.status).toBe(201);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.body).toMatchObject({
      client_id: expect.stringMatching(/^ocl_/),
      client_name: 'Claude  Code',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    expect(ok.body.client_secret).toBeUndefined();

    for (const redirect_uris of [['http://evil.example/cb'], ['javascript:alert(1)'], [], ['https://a.example/#x']]) {
      const bad = await register(t, { redirect_uris });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe('invalid_redirect_uri');
    }
    const notJson = await t.app.request('/oauth/register', { method: 'POST', body: 'nope' });
    expect(notJson.status).toBe(400);
    expect((await notJson.json()).error).toBe('invalid_client_metadata');
  });

  it('throttles registration from one address', async () => {
    const t = createTestApp();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt++) statuses.push((await register(t)).status);
    expect(statuses.slice(0, 20).every((status) => status === 201)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

describe('authorization and consent', () => {
  it('sends the browser to the consent page, and never redirects to a URI it cannot trust', async () => {
    const t = createTestApp();
    const clientId = (await register(t)).body.client_id;
    const { challenge } = pkce();

    const unknown = await authorize(t, authorizeParams('ocl_nobody', challenge));
    expect(unknown).toEqual({ status: 302, location: `${ISSUER}/#/oauth/consent?error=invalid_client` });
    const elsewhere = await authorize(
      t,
      authorizeParams(clientId, challenge, { redirect_uri: 'https://evil.example/cb' }),
    );
    expect(elsewhere.location).toBe(`${ISSUER}/#/oauth/consent?error=invalid_redirect_uri`);

    // A bad request from a client anyone could have registered stays on our page: no open redirect.
    const shown = async (extra: Record<string, string>) =>
      (await authorize(t, authorizeParams(clientId, challenge, extra))).location;
    expect(await shown({ code_challenge: '' })).toBe(`${ISSUER}/#/oauth/consent?error=invalid_request`);
    expect(await shown({ code_challenge_method: 'plain' })).toBe(`${ISSUER}/#/oauth/consent?error=invalid_request`);
    expect(await shown({ response_type: 'token' })).toBe(`${ISSUER}/#/oauth/consent?error=unsupported_response_type`);
    // A client an admin registered gets the error at its redirect URI, as RFC 6749 says.
    const admin = await t.member('admin');
    const trusted = (
      await t.call('POST', '/api/admin/clients', {
        token: admin.token,
        body: { kind: 'interactive', name: 'Portal', redirect_uris: [REDIRECT] },
      })
    ).body.client.id;
    const back = async (extra: Record<string, string>) =>
      queryOf((await authorize(t, authorizeParams(trusted, challenge, extra))).location);
    const noPkce = await back({ code_challenge: '' });
    expect(Object.fromEntries(noPkce)).toMatchObject({ error: 'invalid_request', state: 'state-12345', iss: ISSUER });
    expect((await back({ code_challenge_method: 'plain' })).get('error')).toBe('invalid_request');
    expect((await back({ response_type: 'token' })).get('error')).toBe('unsupported_response_type');
    expect((await back({ resource: 'https://other.example/api/mcp' })).get('error')).toBe('invalid_target');

    const started = await authorize(t, authorizeParams(clientId, challenge));
    expect(started.location).toMatch(new RegExp(`^${ISSUER}/#/oauth/consent\\?request=[A-Za-z0-9_-]{40,}$`));
    // A loopback redirect may come back on another port (RFC 8252).
    const otherPort = await authorize(
      t,
      authorizeParams(clientId, challenge, { redirect_uri: 'http://127.0.0.1:50123/callback' }),
    );
    expect(queryOf(otherPort.location).get('request')).toBeTruthy();
    // Only the hash of the handle is stored.
    const handle = queryOf(started.location).get('request')!;
    const stored = await getDb().select().from(idempotencyKeys).where(eq(idempotencyKeys.scope, 'oauth_request'));
    expect(stored.length).toBe(2);
    expect(JSON.stringify(stored)).not.toContain(handle);
  });

  it('binds a request to the first member who opens it and spends it once', async () => {
    const t = createTestApp();
    const lin = await t.member();
    const chen = await t.member();
    const clientId = (await register(t)).body.client_id;
    const { challenge } = pkce();
    const handle = queryOf((await authorize(t, authorizeParams(clientId, challenge))).location).get('request')!;

    expect((await t.call('GET', `/api/oauth/consent?request=${handle}`)).status).toBe(401);
    const shown = await t.call('GET', `/api/oauth/consent?request=${handle}`, { token: lin.token });
    expect(shown.body).toMatchObject({
      client: { id: clientId, name: 'Claude Code', registration: 'dynamic' },
      redirect_uri: REDIRECT,
      scopes: [...OAUTH_SCOPES],
      granted_scopes: null,
    });
    const stolen = await t.call('GET', `/api/oauth/consent?request=${handle}`, { token: chen.token });
    expect(stolen.body.error.code).toBe('oauth_request_invalid');
    const stolenDecision = await t.call('POST', '/api/oauth/consent', {
      token: chen.token,
      body: { request: handle, decision: 'approve' },
    });
    expect(stolenDecision.body.error.code).toBe('oauth_request_invalid');

    const approved = await t.call('POST', '/api/oauth/consent', {
      token: lin.token,
      body: { request: handle, decision: 'approve', scopes: ['conversations:read', 'agents:read'] },
    });
    const redirect = queryOf(approved.body.redirect_to);
    expect(approved.body.redirect_to.startsWith(`${REDIRECT}?`)).toBe(true);
    expect(redirect.get('code')).toMatch(/^gnh_ac_/);
    expect(redirect.get('state')).toBe('state-12345');
    expect(redirect.get('iss')).toBe(ISSUER);
    const [grant] = await getDb().select().from(oauthGrants).where(eq(oauthGrants.memberId, lin.id));
    expect(grant).toMatchObject({ clientId, status: 'active', scopes: ['agents:read', 'conversations:read'] });

    const again = await t.call('POST', '/api/oauth/consent', {
      token: lin.token,
      body: { request: handle, decision: 'approve' },
    });
    expect(again.body.error.code).toBe('oauth_request_invalid');
    const [approval] = await getDb().select().from(auditEvents).where(eq(auditEvents.action, 'oauth_grant.approve'));
    expect(approval).toMatchObject({ actorId: lin.id, clientId, summary: 'agents:read conversations:read' });

    // The next consent page says what is already granted.
    const next = queryOf((await authorize(t, authorizeParams(clientId, challenge))).location).get('request')!;
    expect(
      (await t.call('GET', `/api/oauth/consent?request=${next}`, { token: lin.token })).body.granted_scopes,
    ).toEqual(['agents:read', 'conversations:read']);
  });

  it('grants nothing beyond the request, and sends a denial back to the client', async () => {
    const t = createTestApp();
    const lin = await t.member();
    const clientId = (await register(t)).body.client_id;
    const { challenge } = pkce();
    const narrow = queryOf(
      (await authorize(t, authorizeParams(clientId, challenge, { scope: 'agents:read openid' }))).location,
    ).get('request')!;
    expect((await t.call('GET', `/api/oauth/consent?request=${narrow}`, { token: lin.token })).body.scopes).toEqual([
      'agents:read',
    ]);
    const wider = await t.call('POST', '/api/oauth/consent', {
      token: lin.token,
      body: { request: narrow, decision: 'approve', scopes: ['runs:read'] },
    });
    expect(wider.body.error.code).toBe('invalid_input');

    const denied = queryOf((await authorize(t, authorizeParams(clientId, challenge))).location).get('request')!;
    const decision = await t.call('POST', '/api/oauth/consent', {
      token: lin.token,
      body: { request: denied, decision: 'deny' },
    });
    expect(Object.fromEntries(queryOf(decision.body.redirect_to))).toMatchObject({
      error: 'access_denied',
      state: 'state-12345',
      iss: ISSUER,
    });
    expect(await getDb().select().from(oauthGrants).where(eq(oauthGrants.memberId, lin.id))).toEqual([]);

    const late = queryOf((await authorize(t, authorizeParams(clientId, challenge))).location).get('request')!;
    await getDb()
      .update(idempotencyKeys)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(idempotencyKeys.scope, 'oauth_request'));
    expect((await t.call('GET', `/api/oauth/consent?request=${late}`, { token: lin.token })).body.error.code).toBe(
      'oauth_request_invalid',
    );
  });
});

describe('the token endpoint', () => {
  it('exchanges a code once, for the right client, redirect and verifier', async () => {
    const t = createTestApp();
    const lin = await t.member();
    const clientId = (await register(t)).body.client_id;
    const other = (await register(t)).body.client_id;
    const { verifier, challenge } = pkce();
    const handle = queryOf((await authorize(t, authorizeParams(clientId, challenge))).location).get('request')!;
    const code = queryOf(
      (await t.call('POST', '/api/oauth/consent', { token: lin.token, body: { request: handle, decision: 'approve' } }))
        .body.redirect_to,
    ).get('code')!;
    const exchange = (fields: Record<string, string>) =>
      postForm(t, '/oauth/token', {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: clientId,
        ...fields,
      });

    // Wrong verifier, client or redirect: refused, and the code survives for its rightful owner.
    expect((await exchange({ code_verifier: pkce().verifier })).body.error).toBe('invalid_grant');
    expect((await exchange({ client_id: other })).body.error).toBe('invalid_grant');
    expect((await exchange({ redirect_uri: 'http://127.0.0.1:1/other' })).body.error).toBe('invalid_grant');
    expect((await exchange({ resource: 'https://other.example/api/mcp' })).body.error).toBe('invalid_target');
    expect((await exchange({ client_id: 'ocl_unknown' })).status).toBe(401);

    const issued = await exchange({ resource: RESOURCE });
    expect(issued.status).toBe(200);
    expect(issued.headers.get('cache-control')).toBe('no-store');
    expect(issued.body).toEqual({
      access_token: expect.stringMatching(/^gnh_at_/),
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: expect.stringMatching(/^gnh_rt_/),
      scope: allScopes,
    });
    expect((await mcp(t, issued.body.access_token)).status).toBe(200);

    // A code used twice: refused, and what it gave is revoked.
    const replay = await exchange({});
    expect(replay.body.error).toBe('invalid_grant');
    expect((await mcp(t, issued.body.access_token)).status).toBe(401);
    const [reuse] = await getDb().select().from(auditEvents).where(eq(auditEvents.action, 'oauth_grant.reuse'));
    expect(reuse).toMatchObject({
      actorType: 'client',
      clientId,
      onBehalfOf: lin.id,
      result: 'denied',
      summary: 'code',
    });

    // Nothing secret is stored in plain text.
    const stored = JSON.stringify([await getDb().select().from(oauthCodes), await getDb().select().from(oauthTokens)]);
    for (const secret of [code, issued.body.access_token, issued.body.refresh_token]) {
      expect(stored).not.toContain(secret);
    }
  });

  it('refuses an expired code and a code issued before a password change', async () => {
    const t = createTestApp();
    const lin = await t.member();
    const clientId = (await register(t)).body.client_id;
    const codeFor = async () => {
      const { verifier, challenge } = pkce();
      const handle = queryOf((await authorize(t, authorizeParams(clientId, challenge))).location).get('request')!;
      const decided = await t.call('POST', '/api/oauth/consent', {
        token: lin.token,
        body: { request: handle, decision: 'approve' },
      });
      return { code: queryOf(decided.body.redirect_to).get('code')!, verifier };
    };
    const exchange = (code: string, verifier: string) =>
      postForm(t, '/oauth/token', {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: clientId,
      });

    const late = await codeFor();
    await getDb()
      .update(oauthCodes)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await exchange(late.code, late.verifier)).body.error).toBe('invalid_grant');

    const before = await codeFor();
    await t.call('POST', '/api/me/password', {
      token: lin.token,
      body: { current_password: TEST_PASSWORD, new_password: 'another-password' },
    });
    expect((await exchange(before.code, before.verifier)).body.error).toBe('invalid_grant');
  });

  it('rotates refresh tokens, narrows on request, and revokes the authorization when a used one returns', async () => {
    const t = createTestApp();
    const lin = await t.member();
    const first = await connect(t, lin);
    const refresh = (token: string, extra: Record<string, string> = {}) =>
      postForm(t, '/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: token,
        client_id: first.clientId,
        resource: RESOURCE,
        ...extra,
      });

    const narrowed = await refresh(first.tokens.refresh_token, { scope: 'agents:read' });
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.scope).toBe('agents:read');
    // The refresh token keeps what was granted: the next refresh can ask for all of it again.
    const second = await refresh(narrowed.body.refresh_token);
    expect(second.body.scope).toBe(allScopes);
    const wider = await refresh(second.body.refresh_token, { scope: 'agents:read agents:write' });
    expect(wider.body.error).toBe('invalid_scope');
    const otherClient = (await register(t)).body.client_id;
    expect((await refresh(second.body.refresh_token, { client_id: otherClient })).body.error).toBe('invalid_grant');

    // The first refresh token comes back: everything of this authorization ends.
    expect((await refresh(first.tokens.refresh_token)).body.error).toBe('invalid_grant');
    expect((await refresh(second.body.refresh_token)).body.error).toBe('invalid_grant');
    expect((await mcp(t, second.body.access_token)).status).toBe(401);
    expect((await mcp(t, first.tokens.access_token)).status).toBe(401);
    const [reuse] = await getDb().select().from(auditEvents).where(eq(auditEvents.action, 'oauth_grant.reuse'));
    expect(reuse).toMatchObject({ summary: 'refresh_token', result: 'denied' });
  });

  it('ends OAuth and personal tokens when the password changes or the member is disabled', async () => {
    const t = createTestApp();
    const admin = await t.member('admin');
    const lin = await t.member();
    const chen = await t.member();
    const linClient = await connect(t, lin);
    const personal = await t.call('POST', '/api/me/tokens', {
      token: lin.token,
      body: { name: 'CLI', scopes: ['agents:read'] },
    });
    expect((await mcp(t, linClient.tokens.access_token)).status).toBe(200);
    expect((await mcp(t, personal.body.token)).status).toBe(200);

    await t.call('POST', '/api/me/password', {
      token: lin.token,
      body: { current_password: TEST_PASSWORD, new_password: 'another-password' },
    });
    expect((await mcp(t, linClient.tokens.access_token)).status).toBe(401);
    expect((await mcp(t, personal.body.token)).status).toBe(401);
    const refreshed = await postForm(t, '/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: linClient.tokens.refresh_token,
      client_id: linClient.clientId,
    });
    expect(refreshed.body.error).toBe('invalid_grant');
    const signedIn = await t.call('POST', '/api/auth/login', {
      body: { email: lin.email, password: 'another-password' },
    });
    expect((await t.call('GET', '/api/me/tokens', { token: signedIn.body.access_token })).body.items).toEqual([]);

    const chenClient = await connect(t, chen);
    await t.call('PATCH', `/api/admin/members/${chen.id}`, { token: admin.token, body: { status: 'disabled' } });
    expect((await mcp(t, chenClient.tokens.access_token)).status).toBe(401);
  });

  it('revokes a token through /oauth/revoke', async () => {
    const t = createTestApp();
    const lin = await t.member();
    const first = await connect(t, lin);
    const other = await connect(t, lin);
    const revoke = (token: string, clientId: string) =>
      postForm(t, '/oauth/revoke', { token, client_id: clientId, token_type_hint: 'access_token' });

    // Another client's token is left alone; an unknown one is not an error.
    expect((await revoke(first.tokens.access_token, other.clientId)).status).toBe(200);
    expect((await mcp(t, first.tokens.access_token)).status).toBe(200);
    expect((await revoke('gnh_at_unknown', first.clientId)).status).toBe(200);

    expect((await revoke(first.tokens.access_token, first.clientId)).status).toBe(200);
    expect((await mcp(t, first.tokens.access_token)).status).toBe(401);
    const fresh = await postForm(t, '/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: first.tokens.refresh_token,
      client_id: first.clientId,
    });
    expect(fresh.status).toBe(200);
    // Revoking a refresh token ends the whole authorization.
    await revoke(fresh.body.refresh_token, first.clientId);
    expect((await mcp(t, fresh.body.access_token)).status).toBe(401);
    expect((await mcp(t, other.tokens.access_token)).status).toBe(200);
  });
});

describe('my external access', () => {
  it('lists the clients I authorized and revokes one with everything it holds', async () => {
    const t = createTestApp();
    const lin = await t.member();
    const chen = await t.member();
    const claude = await connect(t, lin, { approve: ['agents:read', 'runs:read'] });
    await t.call('POST', '/api/me/tokens', { token: lin.token, body: { name: 'CLI', scopes: ['agents:read'] } });
    await mcp(t, claude.tokens.access_token);

    const listed = await t.call('GET', '/api/me/grants', { token: lin.token });
    expect(listed.body).toEqual({
      items: [
        {
          id: expect.stringMatching(/^ogr_/),
          client: {
            id: claude.clientId,
            name: 'Claude Code',
            kind: 'interactive',
            registration: 'dynamic',
            status: 'active',
          },
          scopes: ['agents:read', 'runs:read'],
          status: 'active',
          active_tokens: 2,
          last_used_at: expect.any(String),
          created_at: expect.any(String),
          updated_at: expect.any(String),
        },
      ],
      next_cursor: null,
    });
    const grantId = listed.body.items[0].id;
    expect((await t.call('DELETE', `/api/me/grants/${grantId}`, { token: chen.token })).status).toBe(404);
    expect((await t.call('DELETE', `/api/me/grants/${grantId}`, { token: lin.token })).status).toBe(204);
    expect((await mcp(t, claude.tokens.access_token)).status).toBe(401);
    const refreshed = await postForm(t, '/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: claude.tokens.refresh_token,
      client_id: claude.clientId,
    });
    expect(refreshed.body.error).toBe('invalid_grant');
    expect((await t.call('GET', '/api/me/grants', { token: lin.token })).body.items).toEqual([]);
    const [revoked] = await getDb().select().from(auditEvents).where(eq(auditEvents.action, 'oauth_grant.revoke'));
    expect(revoked).toMatchObject({ actorId: lin.id, resourceId: grantId });

    // The member can authorize it again; it starts with fresh tokens.
    const again = await connect(t, lin, { clientId: claude.clientId });
    expect((await mcp(t, again.tokens.access_token)).status).toBe(200);
  });

  it('creates personal access tokens shown once, with a name, scopes and an expiry', async () => {
    const t = createTestApp();
    const lin = await t.member();
    const chen = await t.member();
    const created = await t.call('POST', '/api/me/tokens', {
      token: lin.token,
      body: { name: 'Laptop CLI', scopes: ['runs:read', 'agents:read'], expires_in_days: 7 },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      id: expect.stringMatching(/^otk_/),
      name: 'Laptop CLI',
      scopes: ['agents:read', 'runs:read'],
      status: 'active',
      last_used_at: null,
      token: expect.stringMatching(/^gnh_pat_/),
    });
    const days = (Date.parse(created.body.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    const stored = JSON.stringify(await getDb().select().from(oauthTokens));
    expect(stored).not.toContain(created.body.token);

    expect((await mcp(t, created.body.token)).status).toBe(200);
    const listed = (await t.call('GET', '/api/me/tokens', { token: lin.token })).body;
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].token).toBeUndefined();
    expect(listed.items[0].last_used_at).toEqual(expect.any(String));
    expect((await t.call('GET', '/api/me/tokens', { token: chen.token })).body.items).toEqual([]);
    // Personal tokens are not listed among the clients I authorized.
    expect((await t.call('GET', '/api/me/grants', { token: lin.token })).body.items).toEqual([]);

    const invalid = await t.call('POST', '/api/me/tokens', {
      token: lin.token,
      body: { name: 'x', scopes: ['everything'] },
    });
    expect(invalid.status).toBe(400);

    await getDb()
      .update(oauthTokens)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(oauthTokens.id, created.body.id));
    expect((await mcp(t, created.body.token)).status).toBe(401);
    expect((await t.call('GET', '/api/me/tokens', { token: lin.token })).body.items[0].status).toBe('expired');

    expect((await t.call('DELETE', `/api/me/tokens/${created.body.id}`, { token: chen.token })).status).toBe(404);
    expect((await t.call('DELETE', `/api/me/tokens/${created.body.id}`, { token: lin.token })).status).toBe(204);
    expect((await t.call('GET', '/api/me/tokens', { token: lin.token })).body.items).toEqual([]);
    const actions = (await getDb().select().from(auditEvents)).map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining(['personal_token.create', 'personal_token.revoke']));
  });

  it('keeps at most twenty live personal tokens', async () => {
    const t = createTestApp();
    const lin = await t.member();
    for (let n = 0; n < 20; n++) {
      const made = await t.call('POST', '/api/me/tokens', {
        token: lin.token,
        body: { name: `t${n}`, scopes: ['agents:read'] },
      });
      expect(made.status).toBe(201);
    }
    const tooMany = await t.call('POST', '/api/me/tokens', {
      token: lin.token,
      body: { name: 'one more', scopes: ['agents:read'] },
    });
    expect(tooMany.body.error.code).toBe('too_many_tokens');
    const page = await t.call('GET', '/api/me/tokens?limit=15', { token: lin.token });
    expect(page.body.items).toHaveLength(15);
    const rest = await t.call('GET', `/api/me/tokens?limit=15&cursor=${page.body.next_cursor}`, { token: lin.token });
    expect(rest.body.items).toHaveLength(5);
    expect(rest.body.next_cursor).toBeNull();
  });
});

describe('admin clients', () => {
  it('lets an admin add, cap, disable and delete interactive clients, with their activity', async () => {
    const t = createTestApp();
    const admin = await t.member('admin');
    const lin = await t.member();
    expect((await t.call('GET', '/api/admin/clients', { token: lin.token })).status).toBe(403);

    const created = await t.call('POST', '/api/admin/clients', {
      token: admin.token,
      body: {
        kind: 'interactive',
        name: 'Team portal',
        redirect_uris: [REDIRECT],
        scopes: ['agents:read', 'runs:read'],
      },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      client_secret: null,
      client: { kind: 'interactive', registration: 'admin', allowed_scopes: ['agents:read', 'runs:read'] },
    });
    const clientId = created.body.client.id;
    const badUris = await t.call('POST', '/api/admin/clients', {
      token: admin.token,
      body: { kind: 'interactive', name: 'Bad', redirect_uris: ['http://evil.example/cb'] },
    });
    expect(badUris.status).toBe(400);

    // A member can grant it no more than its cap, whatever it asks for.
    const linked = await connect(t, lin, { clientId, scope: allScopes });
    expect(linked.tokens.scope).toBe('agents:read runs:read');
    await mcp(t, linked.tokens.access_token);
    const dynamic = (await register(t)).body.client_id;
    await t.call('POST', '/api/me/tokens', { token: lin.token, body: { name: 'CLI', scopes: ['agents:read'] } });

    const listed = (await t.call('GET', '/api/admin/clients', { token: admin.token })).body;
    expect(listed.items.map((client: { id: string }) => client.id)).toEqual([dynamic, clientId]);
    expect(listed.items[1]).toMatchObject({
      name: 'Team portal',
      status: 'active',
      bound_member: null,
      bound_grant_status: null,
      active_grants: 1,
      active_tokens: 2,
      last_used_at: expect.any(String),
    });

    const disabled = await t.call('PATCH', `/api/admin/clients/${clientId}`, {
      token: admin.token,
      body: { status: 'disabled', name: 'Old portal' },
    });
    expect(disabled.body).toMatchObject({ status: 'disabled', name: 'Old portal', active_tokens: 0 });
    expect((await mcp(t, linked.tokens.access_token)).status).toBe(401);
    expect((await authorize(t, authorizeParams(clientId, pkce().challenge))).location).toContain(
      'error=invalid_client',
    );
    await t.call('PATCH', `/api/admin/clients/${clientId}`, { token: admin.token, body: { status: 'active' } });
    // Enabling it again lets it ask for new tokens; the old ones stay ended.
    expect((await mcp(t, linked.tokens.access_token)).status).toBe(401);
    expect((await mcp(t, (await connect(t, lin, { clientId })).tokens.access_token)).status).toBe(200);

    expect((await t.call('DELETE', `/api/admin/clients/${clientId}`, { token: admin.token })).status).toBe(204);
    expect((await t.call('GET', `/api/admin/clients/${clientId}`, { token: admin.token })).status).toBe(404);
    expect(await getDb().select().from(oauthGrants).where(eq(oauthGrants.clientId, clientId))).toEqual([]);
    // The built-in client of personal tokens is not an admin's to see or delete.
    expect((await t.call('DELETE', '/api/admin/clients/personal', { token: admin.token })).status).toBe(404);

    const audited = await getDb()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.actorId, admin.id), sql`${auditEvents.action} like 'oauth_client.%'`));
    expect(audited.map((event) => [event.action, event.summary])).toEqual([
      ['oauth_client.create', 'interactive'],
      ['oauth_client.update', 'name, status'],
      ['oauth_client.update', 'status'],
      ['oauth_client.delete', ''],
    ]);
  });

  it('lets a machine client act as its member only once that member approves', async () => {
    const t = createTestApp();
    const admin = await t.member('admin');
    const lin = await t.member();
    const created = await t.call('POST', '/api/admin/clients', {
      token: admin.token,
      body: { kind: 'machine', name: 'Nightly report', member_id: lin.id, scopes: ['runs:read', 'agents:read'] },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      client_secret: expect.stringMatching(/^gnh_cs_/),
      client: {
        kind: 'machine',
        bound_member: { id: lin.id, name: lin.name, email: lin.email },
        bound_grant_status: 'pending',
        allowed_scopes: ['agents:read', 'runs:read'],
      },
    });
    const clientId = created.body.client.id;
    const secret = created.body.client_secret;
    expect(JSON.stringify(await getDb().select().from(auditEvents))).not.toContain(secret);
    const credentials = (extra: Record<string, string> = {}, headers = {}) =>
      postForm(t, '/oauth/token', { grant_type: 'client_credentials', ...extra }, headers);

    const early = await credentials({ client_id: clientId, client_secret: secret });
    expect(early.body).toMatchObject({ error: 'invalid_grant' });

    const waiting = (await t.call('GET', '/api/me/grants', { token: lin.token })).body.items;
    expect(waiting).toEqual([
      expect.objectContaining({
        status: 'pending',
        client: expect.objectContaining({ id: clientId, kind: 'machine', registration: 'admin' }),
      }),
    ]);
    expect((await t.call('POST', `/api/me/grants/${waiting[0].id}/approve`, { token: admin.token })).status).toBe(404);
    const approved = await t.call('POST', `/api/me/grants/${waiting[0].id}/approve`, { token: lin.token });
    expect(approved.body.status).toBe('active');

    const issued = await credentials({ client_id: clientId, client_secret: secret });
    expect(issued.body).toEqual({
      access_token: expect.stringMatching(/^gnh_at_/),
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'agents:read runs:read',
    });
    expect((await mcp(t, issued.body.access_token)).status).toBe(200);
    const basic = `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;
    const viaBasic = await credentials({ scope: 'runs:read' }, { authorization: basic });
    expect(viaBasic.body.scope).toBe('runs:read');
    expect((await credentials({ scope: 'conversations:read' }, { authorization: basic })).body.error).toBe(
      'invalid_scope',
    );
    const wrong = await credentials({ client_id: clientId, client_secret: 'gnh_cs_wrong' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('invalid_client');
    const wrongBasic = await credentials(
      {},
      { authorization: `Basic ${Buffer.from(`${clientId}:nope`).toString('base64')}` },
    );
    expect(wrongBasic.headers.get('www-authenticate')).toContain('Basic');
    const asCode = await credentials({ client_id: clientId, client_secret: secret, grant_type: 'authorization_code' });
    expect(asCode.body.error).toBe('unauthorized_client');

    const rotated = await t.call('POST', `/api/admin/clients/${clientId}/rotate-secret`, { token: admin.token });
    expect(rotated.body.client_secret).toMatch(/^gnh_cs_/);
    expect((await credentials({ client_id: clientId, client_secret: secret })).status).toBe(401);
    expect((await mcp(t, issued.body.access_token)).status).toBe(401);
    const renewed = await credentials({ client_id: clientId, client_secret: rotated.body.client_secret });
    expect((await mcp(t, renewed.body.access_token)).status).toBe(200);

    // The member can take it back at any time.
    await t.call('DELETE', `/api/me/grants/${waiting[0].id}`, { token: lin.token });
    expect((await mcp(t, renewed.body.access_token)).status).toBe(401);
    expect((await credentials({ client_id: clientId, client_secret: rotated.body.client_secret })).body.error).toBe(
      'invalid_grant',
    );
    const view = (await t.call('GET', `/api/admin/clients/${clientId}`, { token: admin.token })).body;
    expect(view).toMatchObject({ bound_grant_status: 'revoked', active_grants: 0, active_tokens: 0 });

    // An admin's own machine client works at once.
    const own = await t.call('POST', '/api/admin/clients', {
      token: admin.token,
      body: { kind: 'machine', name: 'My script', member_id: admin.id, scopes: ['agents:read'] },
    });
    expect(own.body.client.bound_grant_status).toBe('active');
    const mine = await credentials({ client_id: own.body.client.id, client_secret: own.body.client_secret });
    expect((await mcp(t, mine.body.access_token)).status).toBe(200);
    const interactive = await t.call('POST', `/api/admin/clients/${(await register(t)).body.client_id}/rotate-secret`, {
      token: admin.token,
    });
    expect(interactive.body.error.code).toBe('not_a_machine_client');
  });

  it('throttles guessing a client secret', async () => {
    const t = createTestApp();
    const admin = await t.member('admin');
    const created = await t.call('POST', '/api/admin/clients', {
      token: admin.token,
      body: { kind: 'machine', name: 'Robot', member_id: admin.id, scopes: ['agents:read'] },
    });
    const clientId = created.body.client.id;
    let last = 0;
    for (let attempt = 0; attempt < 11; attempt++) {
      last = (
        await postForm(t, '/oauth/token', {
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: `gnh_cs_${attempt}`,
        })
      ).status;
    }
    expect(last).toBe(429);
  });
});
