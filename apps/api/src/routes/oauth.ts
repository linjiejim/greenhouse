/**
 * Platform OAuth 2.1 routes — authorization for `/api/mcp`.
 *
 * GET  /.well-known/oauth-protected-resource/api/mcp — RFC 9728 metadata
 * GET  /.well-known/oauth-authorization-server          — RFC 8414 metadata
 * GET  /oauth/authorize                                 — open the SPA consent screen
 * POST /oauth/register                                  — dynamic public-client registration
 * POST /oauth/token                                     — code exchange / refresh rotation
 * POST /oauth/revoke                                    — token revocation
 * GET  /api/oauth/authorization                         — validate consent request
 * POST /api/oauth/authorization                         — approve or deny consent
 * GET  /api/oauth/grants                                — current user's grants
 * DELETE /api/oauth/grants/:id                          — revoke current user's grant
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { getDb } from '@greenhouse/db';
import type { PlatformOAuthClientRow } from '@greenhouse/db';
import type { AuthUser } from '../auth/token.js';
import { getAuthUser, requireInternal } from '../auth/middleware.js';
import type { AppEnv } from '../app-env.js';
import { humanActor } from '../platform/actor.js';
import { getPlatformRuntime, PLATFORM_ORG_ID } from '../platform/runtime.js';
import {
  clientSecretMatches,
  expiresAt,
  generateAccessToken,
  generateAuthorizationCode,
  generateOAuthClientId,
  generateRefreshToken,
  getMcpResourceUrl,
  getOAuthWebUrl,
  hashOAuthCredential,
  isValidPkceChallenge,
  isValidPkceVerifier,
  normalizeGrantedScopes,
  normalizeOAuthScopes,
  normalizeRedirectUri,
  oauthAuthorizationServerMetadata,
  oauthProtectedResourceMetadata,
  OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_AUTHORIZATION_CODE_TTL_SECONDS,
  OAUTH_REFRESH_TOKEN_TTL_SECONDS,
  parseStoredOAuthScopes,
  parseStoredStringArray,
  pkceChallenge,
  resourceGroupsFromScopes,
  scopesAreSubset,
  scopesToString,
  type OAuthScope,
} from '../platform/oauth.js';

const MANAGE_OWN_CAPABILITY = 'platform.oauth.manageOwn';
const OAUTH_BODY_LIMIT_BYTES = 64 * 1024;

const registrationSchema = z.object({
  client_name: z.string().trim().min(1).max(120),
  redirect_uris: z.array(z.string().min(1).max(2048)).min(1).max(10),
  token_endpoint_auth_method: z.literal('none').optional().default('none'),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

const authorizationSchema = z.object({
  client_id: z.string().min(1).max(200),
  response_type: z.literal('code'),
  redirect_uri: z.string().min(1).max(2048),
  // Room for every action + resource scope; the challenge advertises them all.
  scope: z.string().max(512).optional(),
  state: z.string().min(8).max(1024),
  code_challenge: z.string().min(1).max(200),
  code_challenge_method: z.literal('S256'),
  resource: z.string().max(2048).optional(),
});

const approvalSchema = authorizationSchema.extend({
  decision: z.enum(['approve', 'deny']),
  /**
   * What the user actually ticked on the consent screen. Omitted = grant the
   * whole request (older consent screens, and clients that skip the picker).
   */
  granted_scopes: z.array(z.string().max(64)).max(64).optional(),
});

interface ValidatedAuthorizationRequest {
  client: PlatformOAuthClientRow;
  input: z.infer<typeof authorizationSchema>;
  scopes: OAuthScope[];
  redirectUri: string;
  resource: string;
}

function noStore(c: { header(name: string, value: string): void }): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

function oauthError(c: Context<AppEnv>, status: 400 | 401 | 413, error: string, description: string) {
  noStore(c);
  return c.json({ error, error_description: description }, status);
}

const oauthBodyLimit = bodyLimit({
  maxSize: OAUTH_BODY_LIMIT_BYTES,
  onError: (c) => oauthError(c, 413, 'invalid_request', 'OAuth request body is too large'),
});

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function buildRedirect(redirectUri: string, values: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  return url.href;
}

async function requireOAuthCapability(c: Context<AppEnv>): Promise<AuthUser | undefined> {
  const user = getAuthUser(c);
  const current = await getDb().users.getById(user.id);
  if (!current || current.status !== 'active' || (current.role !== 'super' && current.role !== 'team'))
    return undefined;
  const decision = await getPlatformRuntime().authorize(humanActor(user, c), MANAGE_OWN_CAPABILITY);
  return decision.allowed ? user : undefined;
}

async function validateAuthorizationRequest(
  raw: unknown,
): Promise<{ ok: true; value: ValidatedAuthorizationRequest } | { ok: false; error: string }> {
  const parsed = authorizationSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid authorization request' };

  const client = await getDb().platformOAuth.getClient(parsed.data.client_id);
  if (!client || client.status !== 'active') return { ok: false, error: 'Unknown or disabled OAuth client' };

  let redirectUri: string;
  try {
    redirectUri = normalizeRedirectUri(parsed.data.redirect_uri);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid redirect URI' };
  }
  if (!parseStoredStringArray(client.redirect_uris).includes(redirectUri)) {
    return { ok: false, error: 'Redirect URI is not registered for this client' };
  }
  if (!isValidPkceChallenge(parsed.data.code_challenge)) {
    return { ok: false, error: 'A valid S256 PKCE challenge is required' };
  }

  let scopes: OAuthScope[];
  try {
    scopes = normalizeOAuthScopes(parsed.data.scope);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid scope' };
  }
  const resource = parsed.data.resource ?? getMcpResourceUrl();
  if (resource !== getMcpResourceUrl()) return { ok: false, error: 'Invalid OAuth resource audience' };

  return { ok: true, value: { client, input: parsed.data, scopes, redirectUri, resource } };
}

async function activeInternalUser(userId: string): Promise<boolean> {
  const user = await getDb().users.getById(userId);
  return !!user && user.status === 'active' && (user.role === 'super' || user.role === 'team');
}

async function issueTokenPair(grantId: string, resource: string, scopes: OAuthScope[]) {
  const accessToken = generateAccessToken();
  const refreshToken = generateRefreshToken();
  const created = await getDb().platformOAuth.createTokenPair(
    grantId,
    {
      token_hash: hashOAuthCredential(accessToken),
      token_type: 'access',
      resource,
      scopes: JSON.stringify(scopes),
      expires_at: expiresAt(OAUTH_ACCESS_TOKEN_TTL_SECONDS),
    },
    {
      token_hash: hashOAuthCredential(refreshToken),
      token_type: 'refresh',
      resource,
      scopes: JSON.stringify(scopes),
      expires_at: expiresAt(OAUTH_REFRESH_TOKEN_TTL_SECONDS),
    },
  );
  if (!created) return undefined;
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: scopesToString(scopes),
  };
}

const oauthRoutes = new Hono<AppEnv>()
  .get('/.well-known/oauth-protected-resource/api/mcp', (c) => {
    noStore(c);
    return c.json(oauthProtectedResourceMetadata());
  })
  // Some clients probe the root metadata endpoint before deriving the
  // path-specific RFC 9728 URL. Both advertise the exact MCP audience.
  .get('/.well-known/oauth-protected-resource', (c) => {
    noStore(c);
    return c.json(oauthProtectedResourceMetadata());
  })
  .get('/.well-known/oauth-authorization-server', (c) => {
    noStore(c);
    return c.json(oauthAuthorizationServerMetadata());
  })
  .get('/oauth/authorize', (c) => {
    const target = new URL('/', getOAuthWebUrl());
    for (const [key, value] of new URL(c.req.url).searchParams) target.searchParams.append(key, value);
    target.searchParams.set('oauth_authorize', '1');
    return c.redirect(target.href, 302);
  })
  .post('/oauth/register', oauthBodyLimit, async (c) => {
    const parsed = registrationSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return oauthError(c, 400, 'invalid_client_metadata', 'Invalid client registration');
    if (
      parsed.data.grant_types?.some((value) => !['authorization_code', 'refresh_token'].includes(value)) ||
      parsed.data.response_types?.some((value) => value !== 'code')
    ) {
      return oauthError(c, 400, 'invalid_client_metadata', 'Only authorization_code and refresh_token are supported');
    }

    let redirectUris: string[];
    try {
      redirectUris = [...new Set(parsed.data.redirect_uris.map(normalizeRedirectUri))];
    } catch (error) {
      return oauthError(
        c,
        400,
        'invalid_redirect_uri',
        error instanceof Error ? error.message : 'Invalid redirect URI',
      );
    }
    const client = await getDb().platformOAuth.registerClient({
      id: generateOAuthClientId(),
      client_name: parsed.data.client_name,
      redirect_uris: JSON.stringify(redirectUris),
    });
    noStore(c);
    return c.json(
      {
        client_id: client.id,
        client_name: client.client_name,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_id_issued_at: Math.floor(new Date(client.created_at).getTime() / 1000),
      },
      201,
    );
  })
  .post('/oauth/token', oauthBodyLimit, async (c) => {
    const body = await c.req.parseBody();
    const grantType = stringField(body.grant_type);
    const clientId = stringField(body.client_id);
    if (!clientId) return oauthError(c, 401, 'invalid_client', 'client_id is required');
    const client = await getDb().platformOAuth.getClient(clientId);
    if (!client || client.status !== 'active')
      return oauthError(c, 401, 'invalid_client', 'Unknown or disabled client');

    if (grantType === 'authorization_code') {
      const code = stringField(body.code);
      const redirectUri = stringField(body.redirect_uri);
      const verifier = stringField(body.code_verifier);
      const requestedResource = stringField(body.resource);
      if (!code || !redirectUri || !verifier || !isValidPkceVerifier(verifier)) {
        return oauthError(c, 400, 'invalid_request', 'code, redirect_uri and a valid code_verifier are required');
      }
      // Bind every attacker-controlled exchange parameter into the atomic consume.
      // A wrong verifier/client/redirect/resource must not burn the legitimate code.
      const resolved = await getDb().platformOAuth.consumeAuthorizationCode({
        code_hash: hashOAuthCredential(code),
        client_id: clientId,
        redirect_uri: redirectUri,
        resource: requestedResource ?? getMcpResourceUrl(),
        code_challenge: pkceChallenge(verifier),
      });
      if (
        !resolved ||
        resolved.code.client_id !== clientId ||
        resolved.code.redirect_uri !== redirectUri ||
        (requestedResource !== undefined && requestedResource !== resolved.code.resource) ||
        resolved.code.resource !== getMcpResourceUrl() ||
        resolved.grant.status !== 'active' ||
        resolved.client.status !== 'active' ||
        pkceChallenge(verifier) !== resolved.code.code_challenge ||
        !(await activeInternalUser(resolved.grant.user_id))
      ) {
        return oauthError(c, 400, 'invalid_grant', 'Authorization code is invalid, expired, or already used');
      }
      let scopes: OAuthScope[];
      let grantScopes: OAuthScope[];
      try {
        scopes = parseStoredOAuthScopes(resolved.code.scopes);
        grantScopes = parseStoredOAuthScopes(resolved.grant.scopes);
      } catch {
        return oauthError(c, 400, 'invalid_grant', 'Authorization code or grant contains invalid scopes');
      }
      if (!scopesAreSubset(scopes, grantScopes)) {
        return oauthError(c, 400, 'invalid_grant', 'Authorization code exceeds the current grant scopes');
      }
      const tokenPair = await issueTokenPair(resolved.grant.id, resolved.code.resource, scopes);
      if (!tokenPair) return oauthError(c, 400, 'invalid_grant', 'The current grant no longer permits this code');
      noStore(c);
      return c.json(tokenPair);
    }

    if (grantType === 'refresh_token') {
      const refreshToken = stringField(body.refresh_token);
      const requestedResource = stringField(body.resource);
      if (!refreshToken) return oauthError(c, 400, 'invalid_request', 'refresh_token is required');
      const tokenHash = hashOAuthCredential(refreshToken);
      const existing = await getDb().platformOAuth.getTokenByHash(tokenHash);
      if (
        !existing ||
        existing.token.token_type !== 'refresh' ||
        existing.grant.client_id !== clientId ||
        (requestedResource !== undefined && requestedResource !== existing.token.resource) ||
        existing.grant.status !== 'active' ||
        existing.client.status !== 'active' ||
        existing.token.revoked_at ||
        new Date(existing.token.expires_at).getTime() <= Date.now() ||
        !(await activeInternalUser(existing.grant.user_id))
      ) {
        return oauthError(c, 400, 'invalid_grant', 'Refresh token is invalid, expired, or revoked');
      }
      let grantedScopes: OAuthScope[];
      let currentGrantScopes: OAuthScope[];
      try {
        grantedScopes = parseStoredOAuthScopes(existing.token.scopes);
        currentGrantScopes = parseStoredOAuthScopes(existing.grant.scopes);
      } catch {
        return oauthError(c, 400, 'invalid_grant', 'Refresh token or grant contains invalid scopes');
      }
      if (!scopesAreSubset(grantedScopes, currentGrantScopes)) {
        return oauthError(c, 400, 'invalid_grant', 'Refresh token exceeds the current grant scopes');
      }
      let scopes = grantedScopes;
      if (stringField(body.scope)) {
        try {
          scopes = normalizeOAuthScopes(stringField(body.scope));
        } catch (error) {
          return oauthError(c, 400, 'invalid_scope', error instanceof Error ? error.message : 'Invalid scope');
        }
        if (!scopesAreSubset(scopes, grantedScopes) || !scopesAreSubset(scopes, currentGrantScopes)) {
          return oauthError(c, 400, 'invalid_scope', 'Refresh scope cannot exceed the token or current grant');
        }
      }
      const consumed = await getDb().platformOAuth.consumeRefreshToken(tokenHash);
      if (
        !consumed ||
        consumed.grant.status !== 'active' ||
        consumed.client.status !== 'active' ||
        consumed.grant.client_id !== clientId
      ) {
        return oauthError(c, 400, 'invalid_grant', 'Refresh token was already used or its grant was revoked');
      }
      try {
        currentGrantScopes = parseStoredOAuthScopes(consumed.grant.scopes);
      } catch {
        return oauthError(c, 400, 'invalid_grant', 'Current grant contains invalid scopes');
      }
      if (!scopesAreSubset(scopes, currentGrantScopes)) {
        return oauthError(c, 400, 'invalid_grant', 'Refresh scope exceeds the current grant');
      }
      const tokenPair = await issueTokenPair(consumed.grant.id, consumed.token.resource, scopes);
      if (!tokenPair) return oauthError(c, 400, 'invalid_grant', 'The current grant no longer permits this refresh');
      noStore(c);
      return c.json(tokenPair);
    }

    if (grantType === 'client_credentials') {
      const secret = stringField(body.client_secret);
      const requestedResource = stringField(body.resource);
      if (
        client.token_endpoint_auth_method !== 'client_secret_post' ||
        !client.client_secret_hash ||
        !client.bound_user_id
      ) {
        return oauthError(c, 401, 'invalid_client', 'This client cannot use client_credentials');
      }
      if (!secret || !clientSecretMatches(secret, client.client_secret_hash)) {
        return oauthError(c, 401, 'invalid_client', 'Invalid client credentials');
      }
      if (requestedResource !== undefined && requestedResource !== getMcpResourceUrl()) {
        return oauthError(c, 400, 'invalid_grant', 'Invalid OAuth resource audience');
      }
      if (!(await activeInternalUser(client.bound_user_id))) {
        return oauthError(c, 400, 'invalid_grant', 'The bound user is unavailable or disabled');
      }

      let allowedScopes: OAuthScope[];
      try {
        allowedScopes = parseStoredOAuthScopes(client.allowed_scopes);
      } catch {
        return oauthError(c, 400, 'invalid_grant', 'Client has invalid allowed scopes');
      }
      let scopes = allowedScopes;
      if (stringField(body.scope)) {
        try {
          scopes = normalizeOAuthScopes(stringField(body.scope));
        } catch (error) {
          return oauthError(c, 400, 'invalid_scope', error instanceof Error ? error.message : 'Invalid scope');
        }
        if (!scopesAreSubset(scopes, allowedScopes)) {
          return oauthError(c, 400, 'invalid_scope', 'Requested scope exceeds the client allowance');
        }
      }

      // The machine grant is created (and re-scoped) only by the admin API; a
      // revoked grant must NOT be silently re-activated here.
      const grant = await getDb().platformOAuth.getGrantByPrincipal(
        client.bound_user_id,
        clientId,
        getMcpResourceUrl(),
      );
      if (!grant || grant.status !== 'active') {
        return oauthError(c, 400, 'invalid_grant', 'The client grant is missing or revoked');
      }
      let grantScopes: OAuthScope[];
      try {
        grantScopes = parseStoredOAuthScopes(grant.scopes);
      } catch {
        return oauthError(c, 400, 'invalid_grant', 'The client grant contains invalid scopes');
      }
      if (!scopesAreSubset(scopes, grantScopes)) {
        return oauthError(c, 400, 'invalid_scope', 'Requested scope exceeds the current grant');
      }

      const accessToken = generateAccessToken();
      const created = await getDb().platformOAuth.createAccessToken(grant.id, {
        token_hash: hashOAuthCredential(accessToken),
        token_type: 'access',
        resource: getMcpResourceUrl(),
        scopes: JSON.stringify(scopes),
        expires_at: expiresAt(OAUTH_ACCESS_TOKEN_TTL_SECONDS),
      });
      if (!created) return oauthError(c, 400, 'invalid_grant', 'The current grant no longer permits token issuance');
      noStore(c);
      return c.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
        scope: scopesToString(scopes),
      });
    }

    return oauthError(c, 400, 'unsupported_grant_type', 'Unsupported grant_type');
  })
  .post('/oauth/revoke', oauthBodyLimit, async (c) => {
    const body = await c.req.parseBody();
    const clientId = stringField(body.client_id);
    const token = stringField(body.token);
    if (!clientId || !token) return oauthError(c, 400, 'invalid_request', 'client_id and token are required');
    const client = await getDb().platformOAuth.getClient(clientId);
    if (!client || client.status !== 'active')
      return oauthError(c, 401, 'invalid_client', 'Unknown or disabled client');
    // Confidential (machine) clients must authenticate to revoke.
    if (client.token_endpoint_auth_method === 'client_secret_post') {
      const secret = stringField(body.client_secret);
      if (!secret || !client.client_secret_hash || !clientSecretMatches(secret, client.client_secret_hash)) {
        return oauthError(c, 401, 'invalid_client', 'Invalid client credentials');
      }
    }
    const hash = hashOAuthCredential(token);
    const existing = await getDb().platformOAuth.getTokenByHash(hash);
    if (existing?.grant.client_id === clientId) await getDb().platformOAuth.revokeToken(hash);
    noStore(c);
    return c.body(null, 200);
  })
  .use('/api/oauth/*', requireInternal())
  .get('/api/oauth/authorization', async (c) => {
    if (!(await requireOAuthCapability(c))) return c.json({ error: 'Forbidden' }, 403);
    const validated = await validateAuthorizationRequest(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!validated.ok) return c.json({ error: validated.error }, 400);
    return c.json({
      client: {
        id: validated.value.client.id,
        name: validated.value.client.client_name,
      },
      redirect_uri: validated.value.redirectUri,
      resource: validated.value.resource,
      scopes: validated.value.scopes,
      state: validated.value.input.state,
    });
  })
  .post('/api/oauth/authorization', oauthBodyLimit, async (c) => {
    const user = await requireOAuthCapability(c);
    if (!user) return c.json({ error: 'Forbidden' }, 403);
    const body = await c.req.json().catch(() => undefined);
    const approval = approvalSchema.safeParse(body);
    if (!approval.success) return c.json({ error: 'Invalid authorization decision' }, 400);
    const validated = await validateAuthorizationRequest(approval.data);
    if (!validated.ok) return c.json({ error: validated.error }, 400);

    if (approval.data.decision === 'deny') {
      return c.json({
        redirect_to: buildRedirect(validated.value.redirectUri, {
          error: 'access_denied',
          error_description: 'The user denied the authorization request',
          state: validated.value.input.state,
        }),
      });
    }

    // The user may hand over less than the client asked for, never more.
    // `normalizeGrantedScopes` validates WITHOUT the request-time expansion:
    // unticking every capability must not read as "grant everything".
    let grantedScopes = validated.value.scopes;
    if (approval.data.granted_scopes) {
      try {
        grantedScopes = normalizeGrantedScopes(approval.data.granted_scopes);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Invalid scope selection' }, 400);
      }
      if (!scopesAreSubset(grantedScopes, validated.value.scopes)) {
        return c.json({ error: 'Selected scopes exceed the authorization request' }, 400);
      }
    }
    // An authorization with no resource group reaches zero tools. Refusing it
    // keeps that state out of storage entirely, so no future reader is tempted
    // to interpret "no groups" as "all groups" (which is how this used to work).
    if (resourceGroupsFromScopes(grantedScopes).length === 0) {
      return c.json({ error: 'Select at least one capability to authorize' }, 400);
    }

    const grant = await getDb().platformOAuth.upsertGrant({
      user_id: user.id,
      client_id: validated.value.client.id,
      resource: validated.value.resource,
      scopes: JSON.stringify(grantedScopes),
    });
    const rawCode = generateAuthorizationCode();
    await getDb().platformOAuth.createAuthorizationCode({
      code_hash: hashOAuthCredential(rawCode),
      grant_id: grant.id,
      client_id: validated.value.client.id,
      redirect_uri: validated.value.redirectUri,
      resource: validated.value.resource,
      scopes: JSON.stringify(grantedScopes),
      code_challenge: validated.value.input.code_challenge,
      expires_at: expiresAt(OAUTH_AUTHORIZATION_CODE_TTL_SECONDS),
    });
    await getDb().platform.recordAudit({
      orgId: PLATFORM_ORG_ID,
      actorId: user.id,
      actorType: 'human',
      requestId: humanActor(user, c).requestId,
      clientId: validated.value.client.id,
      resource: { appId: 'platform', entityId: 'oauthGrant', recordId: grant.id },
      actionId: 'authorizeOAuthClient',
      capability: MANAGE_OWN_CAPABILITY,
      result: 'success',
      summary: { scopes: grantedScopes, resource: validated.value.resource },
    });
    return c.json({
      redirect_to: buildRedirect(validated.value.redirectUri, {
        code: rawCode,
        state: validated.value.input.state,
      }),
    });
  })
  .get('/api/oauth/grants', async (c) => {
    const user = await requireOAuthCapability(c);
    if (!user) return c.json({ error: 'Forbidden' }, 403);
    const grants = await getDb().platformOAuth.listUserGrants(user.id);
    return c.json({
      grants: grants.map(({ grant, client }) => ({
        id: grant.id,
        client: { id: client.id, name: client.client_name, status: client.status },
        resource: grant.resource,
        scopes: parseStoredStringArray(grant.scopes),
        status: grant.status,
        created_at: grant.created_at,
        updated_at: grant.updated_at,
        revoked_at: grant.revoked_at,
      })),
    });
  })
  .delete('/api/oauth/grants/:id', async (c) => {
    const user = await requireOAuthCapability(c);
    if (!user) return c.json({ error: 'Forbidden' }, 403);
    const revoked = await getDb().platformOAuth.revokeGrant(c.req.param('id'), user.id);
    if (!revoked) return c.json({ error: 'OAuth grant not found' }, 404);
    await getDb().platform.recordAudit({
      orgId: PLATFORM_ORG_ID,
      actorId: user.id,
      actorType: 'human',
      requestId: humanActor(user, c).requestId,
      resource: { appId: 'platform', entityId: 'oauthGrant', recordId: c.req.param('id') },
      actionId: 'revokeOAuthGrant',
      capability: MANAGE_OWN_CAPABILITY,
      result: 'success',
      summary: {},
    });
    return c.body(null, 204);
  });

export default oauthRoutes;
