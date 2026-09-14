/**
 * Auth middleware — token validation + role-based access control.
 *
 * Extracts bearer token from Authorization header, validates it,
 * and injects AuthUser into Hono context via c.set('user', ...).
 *
 * Role middleware factories provide per-route access control.
 */

import type { Context, Next } from 'hono';
import { validateAccessToken } from './token.js';
import type { AuthUser, UserRole } from './token.js';
import { userHasFeature } from './features.js';
import { isExtensionPublicPath } from './public-paths.js';
import { getDb } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';

// Re-export for convenience
export type { AuthUser, UserRole };

// ─── Public Paths (skip auth entirely) ───────────────────

const PUBLIC_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/auth/password-link/inspect',
  '/api/auth/password-link/complete',
  '/health',
  // Pre-login workspace personalization (name / logo / theme tokens); never
  // exposes secrets, user data or feature configuration.
  '/api/bootstrap',
  // WeCom redirects the BROWSER here, so the hop carries no Bearer. The
  // credential is `state`: server-generated, single-use, 10-minute expiry,
  // bound to a userId; the route re-reads the account (still an active internal
  // user) before writing and never calls getAuthUser(). `/api/wecom/oauth/start`
  // and `/api/wecom/binding` still require a Bearer (guarded in the route file).
  '/api/wecom/oauth/callback',
  // Feishu redirects the BROWSER here (bind and login share one callback, split
  // by the state's intent), again without a Bearer; the credential is a
  // single-use, 10-minute `state`. `/start-login` and `/exchange` serve the
  // NOT-yet-logged-in QR login (the login page has no token to send): the
  // former only issues a login state, the latter swaps a 60s single-use code
  // for a normal session, rate-limited per IP. `/api/feishu/oauth/start` and
  // `/api/feishu/binding` still require a Bearer (guarded in the route file).
  '/api/feishu/oauth/callback',
  '/api/feishu/oauth/start-login',
  '/api/feishu/oauth/exchange',
  // Read-only "does this deployment offer Feishu login?" probe the login page
  // asks on every mount. Deliberately separate from start-login: using that as
  // the probe would seed a pending state nobody consumes on every password
  // login — a probe must have no side effects.
  '/api/feishu/login-available',
]);

/** Exported for the boundary regression test — see routes/__tests__/attachment-boundary.test.ts. */
export function isPublicPath(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) return true;
  if (isExtensionPublicPath(path)) return true;
  // Frontend static assets — Vite emits the hashed bundle under /assets/* (base './').
  if (path === '/' || path === '/favicon.ico' || path.startsWith('/public/') || path.startsWith('/assets/'))
    return true;
  // The icon set + web manifest referenced from index.html by absolute path
  // (served by the explicit ROOT_STATIC_FILES allowlist in index.ts).
  if (
    path === '/favicon.svg' ||
    path === '/apple-touch-icon.png' ||
    path === '/icon-192.png' ||
    path === '/icon-512.png' ||
    path === '/site.webmanifest'
  )
    return true;
  // Uploaded/generated images — GET /api/upload/:id must be public so browser
  // <img> tags (which can't send an Authorization header) can load them; IDs are
  // unguessable (timestamp + uuid). POST /api/upload (no trailing slash) is NOT
  // matched here, so uploads still require auth via authFetch.
  if (path.startsWith('/api/upload/')) return true;
  // LLM gateway relay uses its own relay-key (API Key) auth, not internal Bearer tokens
  if (path.startsWith('/api/llm/')) return true;
  // Agent tool proxy validates app/CLI bearer tokens itself and applies its own audit/rate limit.
  if (path.startsWith('/api/agent/')) return true;
  // Mission runner push surface authenticates with run-bound task tokens
  // (auth/task-token.ts); the guard re-reads user + run per request. Only the
  // /internal/ subtree is exempt — user-facing Mission routes stay behind the
  // central Bearer middleware. The cloud-agent path is a compatibility alias.
  if (path.startsWith('/api/missions/internal/')) return true;
  if (path.startsWith('/api/cloud-agent/internal/')) return true;
  // MCP server uses its own API-key auth (key bound to an internal user) + audit/rate limit.
  if (path.startsWith('/api/mcp')) return true;
  // OAuth 2.1 protocol endpoints use client credentials / PKCE rather than the
  // app's login bearer. The consent API under /api/oauth stays authenticated.
  if (
    path === '/.well-known/oauth-protected-resource' ||
    path === '/.well-known/oauth-protected-resource/api/mcp' ||
    path === '/.well-known/oauth-authorization-server' ||
    path === '/oauth/authorize' ||
    path === '/oauth/register' ||
    path === '/oauth/token' ||
    path === '/oauth/revoke'
  )
    return true;
  // WebSocket endpoint handles its own auth via query param token
  if (path.startsWith('/api/ws')) return true;
  return false;
}

// ─── Auth Middleware ─────────────────────────────────────

/**
 * Main auth middleware. Validates token and sets user context.
 * Must be applied globally before any route handlers.
 */
export async function authMiddleware(c: Context, next: Next) {
  // Skip public paths
  if (isPublicPath(c.req.path)) return next();

  // Extract token
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return c.json({ error: 'Unauthorized', needsAuth: true }, 401);
  }

  // Validate the signed token, then resolve the current database user. Tokens
  // from deleted, disabled, or former external accounts must not remain usable
  // until their four-hour signature expiry.
  const payload = validateAccessToken(token);
  if (payload) {
    if (payload.role !== 'super' && payload.role !== 'team') {
      return c.json({ error: 'Forbidden: internal account required' }, 403);
    }

    let user;
    try {
      user = await getDb().users.getById(payload.uid);
    } catch (err) {
      logger.error('[auth] user lookup failed:', err);
      return c.json({ error: 'Internal server error' }, 500);
    }
    if (!user || user.status !== 'active') {
      return c.json({ error: 'Unauthorized: account unavailable' }, 401);
    }
    if (payload.authVersion !== user.auth_version) {
      return c.json({ error: 'Unauthorized: credentials revoked', needsAuth: true }, 401);
    }
    if (user.role !== 'super' && user.role !== 'team') {
      return c.json({ error: 'Forbidden: internal account required' }, 403);
    }
    c.set('user', {
      id: user.id,
      role: user.role,
    } as AuthUser);
    return next();
  }

  return c.json({ error: 'Unauthorized', needsAuth: true }, 401);
}

// ─── Role Middleware Factories ────────────────────────────

/**
 * Get the authenticated user from context.
 * Throws if called outside auth middleware (programming error).
 */
export function getAuthUser(c: Context): AuthUser {
  const user = c.get('user') as AuthUser | undefined;
  if (!user) throw new Error('getAuthUser called without auth middleware');
  return user;
}

/**
 * Require any of the specified roles.
 * Usage: app.use('/api/admin/*', requireRole('super'))
 *
 * On failure, returns the user's actual role so the frontend can detect
 * stale sessions (e.g. cached user says 'team' but token is now 'external').
 */
export function requireRole(...roles: UserRole[]) {
  return async (c: Context, next: Next) => {
    const user = getAuthUser(c);
    if (!roles.includes(user.role)) {
      return c.json({ error: 'Forbidden: insufficient permissions', role: user.role, requiredRoles: roles }, 403);
    }
    return next();
  };
}

/**
 * Require an active internal role: exactly super or team.
 */
export function requireInternal() {
  return requireRole('super', 'team');
}

/**
 * Require super admin only.
 */
export function requireSuper() {
  return requireRole('super');
}

/**
 * Require a per-user feature flag to be enabled (super always passes).
 *
 * Stack after requireInternal() so external users are rejected first:
 *   app.use('/api/crm/*', requireInternal());
 *   app.use('/api/crm/*', requireFeature('crm'));
 *
 * Resolution rules live in @greenhouse/types/features (see resolveUserFeatures).
 */
export function requireFeature(feature: string) {
  return async (c: Context, next: Next) => {
    const user = getAuthUser(c);
    const allowed = await userHasFeature(user.id, user.role, feature);
    if (!allowed) {
      return c.json({ error: 'Forbidden: feature not enabled', feature, role: user.role }, 403);
    }
    return next();
  };
}
