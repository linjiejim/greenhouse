/**
 * MCP runtime — auth bridge for `/api/mcp`.
 *
 * OAuth-only: external agents authenticate with an OAuth access token issued
 * either through Authorization Code + PKCE (interactive clients) or through
 * client_credentials (admin-created machine clients bound to an internal
 * user). Every request re-resolves token → grant → user and builds the
 * AgentIdentity consumed by the proxy layer.
 *
 * The authorizing/bound user's permissions are the security boundary: the
 * proxy can only ever narrow them (tools ∩ allowlist ∩ scope). Machine clients
 * must bind a least-privilege internal user — never a super or a personal
 * account.
 */

import type { Context, Next } from 'hono';
import { logger } from '@greenhouse/utils/logger';
import { getDb } from '@greenhouse/db';
import { getClientIP } from '../auth/api-key.js';
import type { AgentIdentity } from './api-auth.js';
import { MUTATING_PROXY_ALLOWLIST } from './tool-proxy.js';
import { mcpToolIdsForGroups } from '../tools/registry.js';
import { InMemoryRateLimiter } from '../security/security.js';
import {
  getMcpResourceUrl,
  getProtectedResourceMetadataUrl,
  hashOAuthCredential,
  isOAuthAccessToken,
  oauthSupportedScopes,
  parseStoredOAuthScopes,
  resourceGroupsFromScopes,
  scopesAreSubset,
} from '../platform/oauth.js';

/** Channel recorded for MCP traffic. Reuses the existing `a2a` enum value. */
export const MCP_AUDIT_CHANNEL = 'a2a' as const;

const oauthLimiter = new InMemoryRateLimiter(120_000);
const OAUTH_RPM_LIMIT = 120;
const OAUTH_RPD_LIMIT = 10_000;

/**
 * Advertised in every challenge. MCP clients (SEP-835) take the WWW-Authenticate
 * `scope` over the resource metadata's `scopes_supported`, so naming only
 * `mcp:read` here silently pinned every discovered client to a read-only grant —
 * write tools then never appear in tools/list and the user gets no say. We
 * advertise the full set instead: the consent screen still lists each scope and
 * only grants what the resource owner approves, and writes stay confirm-gated.
 */
/** Computed per challenge: extensions register their groups during boot. */
const challengeScope = () => oauthSupportedScopes().join(' ');

function oauthChallenge(c: Context, message: string, status: 401 | 403, error?: string) {
  const params = [
    `resource_metadata="${getProtectedResourceMetadataUrl()}"`,
    `scope="${challengeScope()}"`,
    ...(error ? [`error="${error}"`] : []),
  ];
  c.header('WWW-Authenticate', `Bearer ${params.join(', ')}`);
  return c.json({ error: { message, type: 'auth_error' } }, status);
}

async function oauthIdentityMiddleware(c: Context, rawToken: string, next: Next) {
  let resolved;
  try {
    resolved = await getDb().platformOAuth.getTokenByHash(hashOAuthCredential(rawToken));
  } catch (error) {
    logger.error('[mcp-auth] OAuth token lookup failed:', error);
    return c.json({ error: { message: 'Internal server error', type: 'server_error' } }, 500);
  }

  if (
    !resolved ||
    resolved.token.token_type !== 'access' ||
    resolved.token.revoked_at ||
    new Date(resolved.token.expires_at).getTime() <= Date.now() ||
    resolved.token.resource !== getMcpResourceUrl() ||
    resolved.grant.status !== 'active' ||
    resolved.grant.resource !== getMcpResourceUrl() ||
    resolved.client.status !== 'active'
  ) {
    return oauthChallenge(c, 'Invalid, expired, or revoked OAuth access token', 401, 'invalid_token');
  }

  let scopes;
  let grantScopes;
  try {
    scopes = parseStoredOAuthScopes(resolved.token.scopes);
    grantScopes = parseStoredOAuthScopes(resolved.grant.scopes);
  } catch {
    return oauthChallenge(c, 'OAuth token or grant contains invalid scopes', 401, 'invalid_token');
  }
  if (!scopesAreSubset(scopes, grantScopes)) {
    return oauthChallenge(c, 'OAuth token exceeds the current grant scopes', 401, 'invalid_token');
  }
  if (!scopes.includes('mcp:read')) {
    return oauthChallenge(c, 'OAuth token does not grant mcp:read', 403, 'insufficient_scope');
  }

  const user = await getDb().users.getById(resolved.grant.user_id);
  if (!user || user.status !== 'active') {
    return oauthChallenge(c, 'The authorizing user is unavailable or disabled', 401, 'invalid_token');
  }
  if (user.role !== 'super' && user.role !== 'team') {
    return oauthChallenge(c, 'MCP access requires an internal user', 403, 'insufficient_scope');
  }

  // Resource groups say WHICH data, the action scopes say WHICH verbs; the
  // reachable set is their product. `allowedTools` narrows reads and
  // `allowedWriteTools` narrows writes (resolveProxyToolIds), and both are only
  // ever a narrowing — the bound user's own permissions are still applied on
  // top, per request, in composeMcpContext.
  const groupTools = mcpToolIdsForGroups(resourceGroupsFromScopes(scopes));
  const identity: AgentIdentity = {
    userId: user.id,
    userRole: user.role,
    allowedTools: [...groupTools].filter((id) => !MUTATING_PROXY_ALLOWLIST.has(id)),
    allowedWriteTools: scopes.includes('mcp:write')
      ? [...groupTools].filter((id) => MUTATING_PROXY_ALLOWLIST.has(id))
      : [],
    allowedWorkspaces: [],
  };
  c.set('agentIdentity', identity);
  c.set('user', { id: identity.userId, role: identity.userRole });
  c.set('oauthClientId', resolved.client.id);
  c.set('oauthScopes', scopes);
  // Machine (client_credentials) tokens are distinguished in platform audit.
  c.set(
    'oauthAuthMethod',
    resolved.client.token_endpoint_auth_method === 'client_secret_post' ? 'oauth-client' : 'oauth',
  );

  const rateKey = `${resolved.client.id}:${resolved.grant.user_id}`;
  const rpm = oauthLimiter.check(`mcp-oauth:rpm:${rateKey}`, 60_000, OAUTH_RPM_LIMIT);
  c.header('X-RateLimit-Limit', String(OAUTH_RPM_LIMIT));
  c.header('X-RateLimit-Remaining', String(Math.max(0, rpm.remaining)));
  c.header('X-RateLimit-Reset', String(Math.ceil(rpm.resetAt / 1000)));
  if (!rpm.allowed) return c.json({ error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } }, 429);
  const rpd = oauthLimiter.check(`mcp-oauth:rpd:${rateKey}`, 86_400_000, OAUTH_RPD_LIMIT);
  if (!rpd.allowed) return c.json({ error: { message: 'Daily rate limit exceeded', type: 'rate_limit_error' } }, 429);

  if (!resolved.token.last_used_at || Date.now() - new Date(resolved.token.last_used_at).getTime() > 5 * 60 * 1000) {
    try {
      await getDb().platformOAuth.touchAccessToken(resolved.token.id);
    } catch (error) {
      logger.warn('[mcp-auth] could not update OAuth token activity', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return next();
}

/**
 * OAuth-only MCP credential boundary. Interactive clients present tokens from
 * the Authorization Code + PKCE flow; automation presents tokens from
 * client_credentials. Anything else — including legacy `lpai_sk_*` keys — gets
 * a 401 with the RFC 9728 challenge pointing at the OAuth metadata.
 */
export async function mcpCredentialMiddleware(c: Context, next: Next) {
  const header = c.req.header('Authorization');
  const rawToken = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (rawToken && isOAuthAccessToken(rawToken)) {
    return oauthIdentityMiddleware(c, rawToken, next);
  }
  return oauthChallenge(
    c,
    'MCP requires an OAuth access token (authorization code or client_credentials)',
    401,
    'invalid_token',
  );
}

// ─── Audit ─────────────────────────────────────────────────

/**
 * Record an MCP request/tool-call into the shared `api_audit_log`, attributed to
 * the OAuth client (`app_id`) and the authorizing/bound internal user (`user_id`).
 */
export async function recordMcpAudit(
  c: Context,
  opts: { endpoint: string; statusCode: number; durationMs: number; error?: string; meta?: Record<string, unknown> },
): Promise<void> {
  try {
    const oauthClientId = c.get('oauthClientId') as string | undefined;
    const identity = c.get('agentIdentity') as AgentIdentity | undefined;
    await getDb().apiAudit.record({
      app_id: oauthClientId ?? 'mcp:unknown',
      endpoint: opts.endpoint,
      method: c.req.method,
      user_id: identity?.userId,
      channel: MCP_AUDIT_CHANNEL,
      status_code: opts.statusCode,
      duration_ms: opts.durationMs,
      meta: opts.meta,
      ip_address: getClientIP(c),
      error: opts.error,
    });
  } catch (err) {
    logger.error('[mcp-auth] failed to record audit:', err);
  }
}
