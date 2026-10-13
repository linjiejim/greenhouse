/**
 * Public, the OAuth 2.1 authorization server for `/api/mcp` (errors in the RFC 6749 shape
 * `{ error, error_description }`, not the API envelope):
 * GET    /.well-known/oauth-authorization-server    RFC 8414 metadata
 * GET    /.well-known/oauth-protected-resource[/api/mcp]   RFC 9728 metadata of /api/mcp
 * POST   /oauth/register                  RFC 7591: an interactive client registers itself
 * GET    /oauth/authorize                 checks the request, then the browser goes to #/oauth/consent?request=
 * POST   /oauth/token                     authorization_code (PKCE S256), refresh_token, client_credentials
 * POST   /oauth/revoke                    RFC 7009
 *
 * Signed in:
 * GET    /api/oauth/consent?request=      the consent page: who asks, for what (binds the request to me)
 * POST   /api/oauth/consent               approve (maybe fewer scopes) or deny → { redirect_to }
 * GET    /api/me/grants                   clients I authorized, and machine clients waiting for me
 * POST   /api/me/grants/:id/approve       let a machine client an admin bound to me act as me
 * DELETE /api/me/grants/:id               revoke: its tokens end at once
 * GET    /api/me/tokens                   my personal access tokens
 * POST   /api/me/tokens                   create one (name, scopes, days) → the token, shown once
 * DELETE /api/me/tokens/:id               revoke it
 * GET    /api/admin/clients               admin: clients with their recent activity
 * POST   /api/admin/clients               admin: an interactive client, or a machine client (secret shown once)
 * GET    /api/admin/clients/:id           admin: one client
 * PATCH  /api/admin/clients/:id           admin: rename, disable (its tokens end) or enable
 * POST   /api/admin/clients/:id/rotate-secret   admin: a new secret, shown once; the old one and its tokens end
 * DELETE /api/admin/clients/:id           admin: delete it with its grants and tokens
 */

import type { Context } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  consentDecisionInputSchema,
  consentQuerySchema,
  createClientInputSchema,
  createPersonalTokenInputSchema,
  idParamSchema,
  pageQuerySchema,
  updateClientInputSchema,
} from '@greenhouse/contract';
import type { AppEnv } from '../../http/env.js';
import { readJson, readParam, readQuery } from '../../http/validate.js';
import { openCors } from '../../security/headers.js';
import { RateLimiter } from '../../security/rate-limit.js';
import { OAuthError, resourceMetadata, serverMetadata } from './protocol.js';
import type { ClientAuth, OAuthService } from './service.js';

const BODY_LIMIT = 64 * 1024;

function noStore(c: Context) {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

function oauthError(c: Context, error: OAuthError, basic = false) {
  noStore(c);
  if (error.status === 401 && basic) c.header('WWW-Authenticate', 'Basic realm="greenhouse"');
  return c.json({ error: error.error, error_description: error.message }, error.status);
}

/** Form fields (RFC 6749 requires form encoding; JSON is accepted too). Only string values count. */
async function readForm(c: Context): Promise<Record<string, string>> {
  const type = c.req.header('content-type') ?? '';
  let raw: Record<string, unknown>;
  try {
    raw = type.includes('application/json')
      ? ((await c.req.json()) as Record<string, unknown>)
      : ((await c.req.parseBody()) as Record<string, unknown>);
  } catch {
    throw new OAuthError(400, 'invalid_request', 'The body could not be read.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

/** HTTP Basic client credentials (RFC 6749 §2.3.1: each part form-encoded). */
function readBasic(c: Context): { id: string; secret: string } | null {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(c.req.header('authorization') ?? '');
  if (!match) return null;
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
  const at = decoded.indexOf(':');
  if (at < 1) return null;
  const decode = (part: string) => {
    try {
      return decodeURIComponent(part.replace(/\+/g, ' '));
    } catch {
      return part;
    }
  };
  return { id: decode(decoded.slice(0, at)), secret: decode(decoded.slice(at + 1)) };
}

export function oauthProtocolRoutes(deps: { oauth: OAuthService; clientIp: (c: Context) => string }) {
  const { oauth } = deps;
  const registrations = new RateLimiter(20, 60 * 60_000);
  const authorizations = new RateLimiter(30, 60_000);
  const tokenCalls = new RateLimiter(60, 60_000);
  const secretAttempts = new RateLimiter(10, 60_000);
  const limited = (c: Context, limiter: RateLimiter, key: string) => {
    const wait = limiter.hit(key);
    if (!wait) return null;
    noStore(c);
    c.header('Retry-After', String(wait));
    return c.json(
      { error: 'rate_limited', error_description: `Too many requests. Try again in ${wait} seconds.` },
      429,
    );
  };
  const limit = bodyLimit({
    maxSize: BODY_LIMIT,
    onError: (c) => oauthError(c, new OAuthError(400, 'invalid_request', 'The body is too large.')),
  });
  const authServer = (c: Context) => {
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(serverMetadata(oauth.endpoints));
  };
  const protectedResource = (c: Context) => {
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(resourceMetadata(oauth.endpoints));
  };

  return new Hono<AppEnv>()
    .use('/.well-known/*', openCors)
    .use('/oauth/register', openCors, limit)
    .use('/oauth/token', openCors, limit)
    .use('/oauth/revoke', openCors, limit)
    .get('/.well-known/oauth-authorization-server', authServer)
    .get('/.well-known/oauth-authorization-server/*', authServer)
    .get('/.well-known/oauth-protected-resource', protectedResource)
    .get('/.well-known/oauth-protected-resource/*', protectedResource)
    .post('/oauth/register', async (c) => {
      const blocked = limited(c, registrations, `register:${deps.clientIp(c)}`);
      if (blocked) return blocked;
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return oauthError(c, new OAuthError(400, 'invalid_client_metadata', 'The body must be JSON.'));
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return oauthError(c, new OAuthError(400, 'invalid_client_metadata', 'The body must be a JSON object.'));
      }
      try {
        const registered = await oauth.register(body as Record<string, unknown>);
        noStore(c);
        return c.json(registered, 201);
      } catch (error) {
        if (error instanceof OAuthError) return oauthError(c, error);
        throw error;
      }
    })
    .get('/oauth/authorize', async (c) => {
      const blocked = limited(c, authorizations, `authorize:${deps.clientIp(c)}`);
      if (blocked) return blocked;
      noStore(c);
      return c.redirect(await oauth.authorize(c.req.query()), 302);
    })
    .post('/oauth/token', async (c) => {
      const basic = readBasic(c);
      try {
        const auth = await clientAuth(c, basic);
        if (auth instanceof Response) return auth;
        const tokens = await oauth.token(auth);
        secretAttempts.reset(`secret:${basic?.id ?? auth.form.client_id}`);
        noStore(c);
        return c.json(tokens);
      } catch (error) {
        if (error instanceof OAuthError) return oauthError(c, error, !!basic);
        throw error;
      }
    })
    .post('/oauth/revoke', async (c) => {
      const basic = readBasic(c);
      try {
        const auth = await clientAuth(c, basic);
        if (auth instanceof Response) return auth;
        await oauth.revoke(auth);
        noStore(c);
        return c.body(null, 200);
      } catch (error) {
        if (error instanceof OAuthError) return oauthError(c, error, !!basic);
        throw error;
      }
    });

  /** The request's client credentials, once the address and (with a secret) the client are under their limits. */
  async function clientAuth(c: Context, basic: ClientAuth['basic']): Promise<ClientAuth | Response> {
    const blocked = limited(c, tokenCalls, `token:${deps.clientIp(c)}`);
    if (blocked) return blocked;
    const form = await readForm(c);
    const clientId = basic?.id ?? form.client_id;
    if ((basic || form.client_secret) && clientId) {
      const guessing = limited(c, secretAttempts, `secret:${clientId}`);
      if (guessing) return guessing;
    }
    return { basic, form };
  }
}

/** Mounted at /api/oauth, behind requireMember: the web app's consent page. */
export function oauthConsentRoutes(oauth: OAuthService) {
  return new Hono<AppEnv>()
    .get('/consent', async (c) =>
      c.json(await oauth.inspect(c.get('member').id, readQuery(c, consentQuerySchema).request)),
    )
    .post('/consent', async (c) =>
      c.json(await oauth.decide(c.get('member').id, await readJson(c, consentDecisionInputSchema))),
    );
}

/** Mounted at /api/me/grants. */
export function grantRoutes(oauth: OAuthService) {
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await oauth.grants(c.get('member').id, readQuery(c, pageQuerySchema))))
    .post('/:id/approve', async (c) =>
      c.json(await oauth.approveGrant(c.get('member').id, readParam(c, 'id', idParamSchema))),
    )
    .delete('/:id', async (c) => {
      await oauth.revokeGrant(c.get('member').id, readParam(c, 'id', idParamSchema));
      return c.body(null, 204);
    });
}

/** Mounted at /api/me/tokens. */
export function personalTokenRoutes(oauth: OAuthService) {
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await oauth.personalTokens(c.get('member').id, readQuery(c, pageQuerySchema))))
    .post('/', async (c) => {
      const created = await oauth.createPersonalToken(
        c.get('member').id,
        await readJson(c, createPersonalTokenInputSchema),
      );
      noStore(c);
      return c.json(created, 201);
    })
    .delete('/:id', async (c) => {
      await oauth.revokePersonalToken(c.get('member').id, readParam(c, 'id', idParamSchema));
      return c.body(null, 204);
    });
}

/** Mounted at /api/admin/clients, which already requires an admin. */
export function adminClientRoutes(oauth: OAuthService) {
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await oauth.clients(readQuery(c, pageQuerySchema))))
    .post('/', async (c) => {
      const created = await oauth.createClient(c.get('member').id, await readJson(c, createClientInputSchema));
      noStore(c);
      return c.json(created, 201);
    })
    .get('/:id', async (c) => c.json(await oauth.client(readParam(c, 'id', idParamSchema))))
    .patch('/:id', async (c) =>
      c.json(
        await oauth.updateClient(
          c.get('member').id,
          readParam(c, 'id', idParamSchema),
          await readJson(c, updateClientInputSchema),
        ),
      ),
    )
    .post('/:id/rotate-secret', async (c) => {
      const rotated = await oauth.rotateSecret(c.get('member').id, readParam(c, 'id', idParamSchema));
      noStore(c);
      return c.json(rotated);
    })
    .delete('/:id', async (c) => {
      await oauth.deleteClient(c.get('member').id, readParam(c, 'id', idParamSchema));
      return c.body(null, 204);
    });
}
