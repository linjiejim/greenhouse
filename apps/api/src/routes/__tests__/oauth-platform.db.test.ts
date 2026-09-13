/**
 * Platform OAuth 2.1 integration tests (real PostgreSQL).
 *
 * Covers discovery, dynamic public-client registration, consent, PKCE,
 * one-time codes, refresh rotation, grant revocation and MCP bearer identity.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import type { AppEnv } from '../../app-env.js';
import oauthRoutes from '../oauth.js';
import { knowledgeRegistration } from '../../platform/knowledge/registration.js';
import { projectsRegistration } from '../../platform/projects/application.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { mcpCredentialMiddleware } from '../../agent-runtime/mcp-auth.js';
import {
  generateAuthorizationCode,
  generateClientSecret,
  generateOAuthClientId,
  hashOAuthCredential,
  normalizeOAuthScopes,
  OAUTH_SUPPORTED_SCOPES,
  pkceChallenge,
} from '../../platform/oauth.js';

/**
 * Compare scope strings as sets: assertions should express which authority was
 * granted, not the exact roster of resource groups (which grows over time).
 */
const scopeSet = (scope: string) => new Set(scope.split(' ').filter(Boolean));
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

const API_URL = 'http://localhost:3000';
const REDIRECT_URI = 'http://127.0.0.1:4567/callback';
const VERIFIER = 'a'.repeat(64);

interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  scope: string;
}

let db: DatabaseProvider;
let user: UserRow;
let userPromise: Promise<UserRow> | undefined;

function ensureUser(): Promise<UserRow> {
  userPromise ??= createInternalTestUser(db, {
    email: 'oauth-user@test.com',
    nickname: 'OAuth user',
  }).then((created) => {
    user = created;
    return created;
  });
  return userPromise;
}

function createApp() {
  const app = new Hono<AppEnv>();
  app.use('/api/oauth/*', async (c, next) => {
    const activeUser = await ensureUser();
    if (c.req.header('x-test-user') !== activeUser.id) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', { id: activeUser.id, role: activeUser.role });
    return next();
  });
  app.route('/', oauthRoutes);
  return app;
}

async function registerClient(app: ReturnType<typeof createApp>) {
  const response = await app.request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'OAuth integration test',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { client_id: string };
}

function authorizationPayload(clientId: string, scope = 'mcp:read mcp:write') {
  return {
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope,
    state: 'oauth-test-state',
    code_challenge: pkceChallenge(VERIFIER),
    code_challenge_method: 'S256',
    resource: `${API_URL}/api/mcp`,
  } as const;
}

async function authorize(app: ReturnType<typeof createApp>, clientId: string, scope?: string) {
  await ensureUser();
  const payload = authorizationPayload(clientId, scope);
  const validation = await app.request(`/api/oauth/authorization?${new URLSearchParams(payload)}`, {
    headers: { 'x-test-user': user.id },
  });
  expect(validation.status).toBe(200);

  const approval = await app.request('/api/oauth/authorization', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': user.id },
    body: JSON.stringify({ ...payload, decision: 'approve' }),
  });
  expect(approval.status).toBe(200);
  const redirect = new URL(((await approval.json()) as { redirect_to: string }).redirect_to);
  expect(redirect.searchParams.get('state')).toBe(payload.state);
  return redirect.searchParams.get('code')!;
}

async function exchange(app: ReturnType<typeof createApp>, clientId: string, code: string, verifier = VERIFIER) {
  return app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
}

function createProtectedApp() {
  const app = new Hono<AppEnv>();
  app.use('*', mcpCredentialMiddleware);
  app.get('/', (c) => {
    const identity = c.get('agentIdentity') as { userId: string; allowedWriteTools: string[] };
    return c.json({
      userId: identity.userId,
      writeTools: identity.allowedWriteTools.length,
      oauthClientId: c.get('oauthClientId'),
    });
  });
  return app;
}

function refresh(app: ReturnType<typeof createApp>, clientId: string, refreshToken: string, scope?: string) {
  return app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
      ...(scope ? { scope } : {}),
    }),
  });
}

describe('Platform OAuth 2.1', () => {
  beforeEach(async () => {
    process.env.API_BASE_URL = API_URL;
    process.env.WEB_BASE_URL = 'http://localhost:3100';
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    userPromise = undefined;
    initializePlatformRuntime(db, [projectsRegistration, knowledgeRegistration]);
  });

  afterEach(async () => {
    resetPlatformRuntimeForTests();
    await db.close();
    _resetProvider();
  });

  it('publishes path-specific resource and authorization-server metadata', async () => {
    const app = createApp();
    const resource = await app.request('/.well-known/oauth-protected-resource/api/mcp');
    expect(resource.status).toBe(200);
    expect(await resource.json()).toMatchObject({
      resource: `${API_URL}/api/mcp`,
      authorization_servers: [API_URL],
      scopes_supported: [...OAUTH_SUPPORTED_SCOPES],
    });

    const server = await app.request('/.well-known/oauth-authorization-server');
    expect(await server.json()).toMatchObject({
      issuer: API_URL,
      authorization_endpoint: `${API_URL}/oauth/authorize`,
      token_endpoint: `${API_URL}/oauth/token`,
      code_challenge_methods_supported: ['S256'],
    });
  });

  it('registers only safe public clients and validates exact redirects', async () => {
    const app = createApp();
    const client = await registerClient(app);
    expect(client.client_id).toMatch(/^lpoa_client_/);

    const invalid = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Unsafe',
        redirect_uris: ['http://evil.example/callback'],
      }),
    });
    expect(invalid.status).toBe(400);

    await ensureUser();
    const payload = { ...authorizationPayload(client.client_id), redirect_uri: `${REDIRECT_URI}/other` };
    const mismatch = await app.request(`/api/oauth/authorization?${new URLSearchParams(payload)}`, {
      headers: { 'x-test-user': user.id },
    });
    expect(mismatch.status).toBe(400);
  });

  it('exchanges an S256 code once and rejects replay or a bad verifier', async () => {
    const app = createApp();
    const { client_id: clientId } = await registerClient(app);
    const code = await authorize(app, clientId);
    const issued = await exchange(app, clientId, code);
    expect(issued.status).toBe(200);
    const issuedBody = (await issued.json()) as IssuedTokens;
    expect(issuedBody).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect(scopeSet(issuedBody.scope).has('mcp:read')).toBe(true);
    expect(scopeSet(issuedBody.scope).has('mcp:write')).toBe(true);

    const replay = await exchange(app, clientId, code);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });

    const secondCode = await authorize(app, clientId);
    const badVerifier = await exchange(app, clientId, secondCode, 'b'.repeat(64));
    expect(badVerifier.status).toBe(400);
    expect(await badVerifier.json()).toMatchObject({ error: 'invalid_grant' });

    const expiredCode = generateAuthorizationCode();
    const grant = (await db.platformOAuth.listUserGrants(user.id))[0]!.grant;
    await db.platformOAuth.createAuthorizationCode({
      code_hash: hashOAuthCredential(expiredCode),
      grant_id: grant.id,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      resource: `${API_URL}/api/mcp`,
      scopes: JSON.stringify(['mcp:read']),
      code_challenge: pkceChallenge(VERIFIER),
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    });
    const expired = await exchange(app, clientId, expiredCode);
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('rotates refresh tokens and refuses reuse or scope escalation', async () => {
    const app = createApp();
    const { client_id: clientId } = await registerClient(app);
    const issued = await exchange(app, clientId, await authorize(app, clientId, 'mcp:read'));
    const tokens = (await issued.json()) as { refresh_token: string };

    const escalated = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: tokens.refresh_token,
        scope: 'mcp:write',
      }),
    });
    expect(escalated.status).toBe(400);
    expect(await escalated.json()).toMatchObject({ error: 'invalid_scope' });

    const rotated = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: tokens.refresh_token,
      }),
    });
    expect(rotated.status).toBe(200);

    const reused = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: tokens.refresh_token,
      }),
    });
    expect(reused.status).toBe(400);
  });

  it('revokes old tokens and unused codes when an existing grant is narrowed', async () => {
    const app = createApp();
    const protectedApp = createProtectedApp();
    const { client_id: clientId } = await registerClient(app);
    const issued = await exchange(app, clientId, await authorize(app, clientId));
    expect(issued.status).toBe(200);
    const oldTokens = (await issued.json()) as IssuedTokens;

    const beforeNarrowing = await protectedApp.request('/', {
      headers: { authorization: `Bearer ${oldTokens.access_token}` },
    });
    expect(beforeNarrowing.status).toBe(200);
    expect((await beforeNarrowing.json()).writeTools).toBeGreaterThan(0);

    // Same-scope consent leaves the existing credential set intact, giving us
    // an unused code that must be invalidated by the subsequent scope change.
    const staleWriteCode = await authorize(app, clientId);
    const narrowedCode = await authorize(app, clientId, 'mcp:read');

    const storedAccess = await db.platformOAuth.getTokenByHash(hashOAuthCredential(oldTokens.access_token));
    const storedRefresh = await db.platformOAuth.getTokenByHash(hashOAuthCredential(oldTokens.refresh_token));
    expect(storedAccess?.token.revoked_at).not.toBeNull();
    expect(storedRefresh?.token.revoked_at).not.toBeNull();

    const staleCodeExchange = await exchange(app, clientId, staleWriteCode);
    expect(staleCodeExchange.status).toBe(400);
    expect(await staleCodeExchange.json()).toMatchObject({ error: 'invalid_grant' });

    const staleAccess = await protectedApp.request('/', {
      headers: { authorization: `Bearer ${oldTokens.access_token}` },
    });
    expect(staleAccess.status).toBe(401);
    expect(await staleAccess.json()).toMatchObject({ error: { type: 'auth_error' } });

    const staleRefresh = await refresh(app, clientId, oldTokens.refresh_token);
    expect(staleRefresh.status).toBe(400);
    expect(await staleRefresh.json()).toMatchObject({ error: 'invalid_grant' });

    const narrowed = await exchange(app, clientId, narrowedCode);
    expect(narrowed.status).toBe(200);
    const narrowedTokens = (await narrowed.json()) as IssuedTokens;
    // Narrowed to read: the write verb is gone (resource groups remain).
    expect(scopeSet(narrowedTokens.scope).has('mcp:read')).toBe(true);
    expect(scopeSet(narrowedTokens.scope).has('mcp:write')).toBe(false);
    const narrowedAccess = await protectedApp.request('/', {
      headers: { authorization: `Bearer ${narrowedTokens.access_token}` },
    });
    expect(narrowedAccess.status).toBe(200);
    expect(await narrowedAccess.json()).toMatchObject({ writeTools: 0, oauthClientId: clientId });
  });

  it('fails closed when a token exceeds the current grant even if its revocation flag is missing', async () => {
    const app = createApp();
    const protectedApp = createProtectedApp();
    const { client_id: clientId } = await registerClient(app);
    const issued = await exchange(app, clientId, await authorize(app, clientId));
    expect(issued.status).toBe(200);
    const tokens = (await issued.json()) as IssuedTokens;
    const grant = (await db.platformOAuth.listUserGrants(user.id))[0]!.grant;

    // Simulate pre-fix/drifted storage: the grant was narrowed but its token
    // rows were not revoked. Runtime checks must still reject that authority.
    await db.executeRaw(
      sql`UPDATE platform_oauth_grants SET scopes = ${JSON.stringify(['mcp:read'])} WHERE id = ${grant.id}`,
    );

    const access = await protectedApp.request('/', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(access.status).toBe(401);
    expect(access.headers.get('www-authenticate')).toContain('error="invalid_token"');

    const refreshed = await refresh(app, clientId, tokens.refresh_token);
    expect(refreshed.status).toBe(400);
    expect(await refreshed.json()).toMatchObject({ error: 'invalid_grant' });

    const disallowedPair = await db.platformOAuth.createTokenPair(
      grant.id,
      {
        token_hash: hashOAuthCredential('drift-access'),
        token_type: 'access',
        resource: `${API_URL}/api/mcp`,
        scopes: JSON.stringify(['mcp:read', 'mcp:write']),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      {
        token_hash: hashOAuthCredential('drift-refresh'),
        token_type: 'refresh',
        resource: `${API_URL}/api/mcp`,
        scopes: JSON.stringify(['mcp:read', 'mcp:write']),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    );
    expect(disallowedPair).toBeUndefined();
  });

  it('builds a scope-limited MCP identity and applies grant revocation immediately', async () => {
    const app = createApp();
    const { client_id: clientId } = await registerClient(app);
    const issued = await exchange(app, clientId, await authorize(app, clientId, 'mcp:read'));
    expect(issued.status).toBe(200);
    const tokens = (await issued.json()) as { access_token: string };

    const protectedApp = createProtectedApp();
    const allowed = await protectedApp.request('/', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    const allowedBody = await allowed.json();
    expect(allowed.status, JSON.stringify(allowedBody)).toBe(200);
    expect(allowedBody).toEqual({ userId: user.id, writeTools: 0, oauthClientId: clientId });

    const grants = await app.request('/api/oauth/grants', { headers: { 'x-test-user': user.id } });
    const grantId = ((await grants.json()) as { grants: Array<{ id: string }> }).grants[0]!.id;
    const revoked = await app.request(`/api/oauth/grants/${grantId}`, {
      method: 'DELETE',
      headers: { 'x-test-user': user.id },
    });
    expect(revoked.status).toBe(204);

    const denied = await protectedApp.request('/', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('invalidates access immediately when the user or OAuth client is disabled', async () => {
    const app = createApp();
    const { client_id: clientId } = await registerClient(app);
    const issued = await exchange(app, clientId, await authorize(app, clientId));
    const tokens = (await issued.json()) as { access_token: string };

    const protectedApp = new Hono<AppEnv>();
    protectedApp.use('*', mcpCredentialMiddleware);
    protectedApp.get('/', (c) => c.json({ userId: c.get('agentIdentity').userId }));

    await db.users.update(user.id, { status: 'disabled' });
    const disabledUser = await protectedApp.request('/', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(disabledUser.status).toBe(401);

    await db.users.update(user.id, { status: 'active' });
    await db.platformOAuth.setClientStatus(clientId, 'disabled');
    const disabledClient = await protectedApp.request('/', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(disabledClient.status).toBe(401);
    expect((await db.platformOAuth.listUserGrants(user.id))[0]!.grant.status).toBe('revoked');
  });

  it('never persists a raw authorization code', async () => {
    await ensureUser();
    const raw = generateAuthorizationCode();
    const { client_id: clientId } = await registerClient(createApp());
    const grant = await db.platformOAuth.upsertGrant({
      user_id: user.id,
      client_id: clientId,
      resource: `${API_URL}/api/mcp`,
      scopes: JSON.stringify(['mcp:read']),
    });
    await db.platformOAuth.createAuthorizationCode({
      code_hash: hashOAuthCredential(raw),
      grant_id: grant.id,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      resource: `${API_URL}/api/mcp`,
      scopes: JSON.stringify(['mcp:read']),
      code_challenge: pkceChallenge(VERIFIER),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const consumeInput = {
      code_hash: hashOAuthCredential(raw),
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      resource: `${API_URL}/api/mcp`,
      code_challenge: pkceChallenge(VERIFIER),
    };
    expect(raw).toMatch(/^lpoa_ac_/);
    expect(await db.platformOAuth.consumeAuthorizationCode({ ...consumeInput, code_hash: raw })).toBeUndefined();
    expect(
      await db.platformOAuth.consumeAuthorizationCode({
        ...consumeInput,
        code_challenge: pkceChallenge('x'.repeat(43)),
      }),
    ).toBeUndefined();
    expect(await db.platformOAuth.consumeAuthorizationCode(consumeInput)).toBeDefined();
  });

  // ─── client_credentials (machine clients) ────────────────

  describe('client_credentials machine clients', () => {
    async function createMachine(scopes: string[] = ['mcp:read']) {
      await ensureUser();
      const clientId = generateOAuthClientId();
      const secret = generateClientSecret();
      // The admin API normalizes before persisting — which fills in every
      // resource group when the caller names none. Persisting the raw list here
      // would produce a client that legitimately reaches zero tools.
      const stored = JSON.stringify(normalizeOAuthScopes(scopes.join(' ')));
      await db.platformOAuth.registerMachineClient({
        id: clientId,
        client_name: 'Machine test',
        client_secret_hash: hashOAuthCredential(secret),
        bound_user_id: user.id,
        allowed_scopes: stored,
      });
      await db.platformOAuth.upsertGrant({
        user_id: user.id,
        client_id: clientId,
        resource: `${API_URL}/api/mcp`,
        scopes: stored,
      });
      return { clientId, secret };
    }

    function clientCredentials(app: ReturnType<typeof createApp>, clientId: string, secret: string, scope?: string) {
      return app.request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: secret,
          ...(scope ? { scope } : {}),
        }),
      });
    }

    it('advertises client_credentials and client_secret_post in metadata', async () => {
      const app = createApp();
      const metadata = (await (await app.request('/.well-known/oauth-authorization-server')).json()) as {
        grant_types_supported: string[];
        token_endpoint_auth_methods_supported: string[];
      };
      expect(metadata.grant_types_supported).toContain('client_credentials');
      expect(metadata.token_endpoint_auth_methods_supported).toContain('client_secret_post');
    });

    it('issues an access-only token that authenticates as the bound user', async () => {
      const app = createApp();
      const { clientId, secret } = await createMachine(['mcp:read', 'mcp:write']);
      const response = await clientCredentials(app, clientId, secret);
      expect(response.status).toBe(200);
      const tokens = (await response.json()) as {
        access_token: string;
        refresh_token?: string;
        scope: string;
        expires_in: number;
      };
      expect(tokens.access_token).toMatch(/^lpoa_at_/);
      expect(tokens.refresh_token).toBeUndefined();
      expect(scopeSet(tokens.scope).has('mcp:read')).toBe(true);
      expect(scopeSet(tokens.scope).has('mcp:write')).toBe(true);

      const protectedApp = createProtectedApp();
      const allowed = await protectedApp.request('/', {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      const body = (await allowed.json()) as { userId: string; writeTools: number; oauthClientId: string };
      expect(allowed.status).toBe(200);
      expect(body.userId).toBe(user.id);
      expect(body.oauthClientId).toBe(clientId);
      expect(body.writeTools).toBeGreaterThan(0);
    });

    it('caps requested scopes at the client allowance', async () => {
      const app = createApp();
      const { clientId, secret } = await createMachine(['mcp:read']);
      const denied = await clientCredentials(app, clientId, secret, 'mcp:read mcp:write');
      expect(denied.status).toBe(400);
      expect(((await denied.json()) as { error: string }).error).toBe('invalid_scope');

      const readOnly = await clientCredentials(app, clientId, secret);
      const tokens = (await readOnly.json()) as { access_token: string };
      const protectedApp = createProtectedApp();
      const body = (await (
        await protectedApp.request('/', { headers: { authorization: `Bearer ${tokens.access_token}` } })
      ).json()) as { writeTools: number };
      expect(body.writeTools).toBe(0);
    });

    it('rejects wrong secrets and public clients', async () => {
      const app = createApp();
      const { clientId } = await createMachine();
      const wrongSecret = await clientCredentials(app, clientId, generateClientSecret());
      expect(wrongSecret.status).toBe(401);

      const { client_id: publicClientId } = await registerClient(app);
      const publicAttempt = await clientCredentials(app, publicClientId, generateClientSecret());
      expect(publicAttempt.status).toBe(401);
    });

    it('does not re-activate a revoked machine grant', async () => {
      const app = createApp();
      const { clientId, secret } = await createMachine();
      const grant = await db.platformOAuth.getGrantByPrincipal(user.id, clientId, `${API_URL}/api/mcp`);
      await db.platformOAuth.revokeGrant(grant!.id);
      const denied = await clientCredentials(app, clientId, secret);
      expect(denied.status).toBe(400);
      expect(((await denied.json()) as { error: string }).error).toBe('invalid_grant');
    });

    it('rejects legacy lpai_sk keys at the MCP boundary with the OAuth challenge', async () => {
      const protectedApp = createProtectedApp();
      const denied = await protectedApp.request('/', {
        headers: { authorization: `Bearer lpai_sk_${'a'.repeat(64)}` },
      });
      expect(denied.status).toBe(401);
      expect(denied.headers.get('www-authenticate')).toContain('resource_metadata=');
    });

    it('advertises every supported scope in the challenge', async () => {
      // MCP clients (SEP-835) prefer this scope over the resource metadata's
      // scopes_supported — advertising only mcp:read pins them to read-only
      // grants and hides every write tool with no way for the user to opt in.
      const protectedApp = createProtectedApp();
      const denied = await protectedApp.request('/');
      expect(denied.status).toBe(401);
      expect(denied.headers.get('www-authenticate')).toContain(`scope="${OAUTH_SUPPORTED_SCOPES.join(' ')}"`);
    });
  });
});
