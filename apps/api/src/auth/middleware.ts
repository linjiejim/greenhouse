/**
 * Auth middleware — token validation + role-based access control.
 *
 * Extracts bearer token from Authorization header, validates it,
 * and injects AuthUser into Hono context via c.set('user', ...).
 *
 * Role middleware factories provide per-route access control.
 */

import type { Context, Next } from 'hono';
import { validateAccessToken, validateExtUiToken, extUiPathAllowed } from './token.js';
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
  '/api/auth/providers',
  '/api/auth/refresh',
  '/api/auth/password-link/inspect',
  '/api/auth/password-link/complete',
  '/health',
  // Pre-login workspace personalization (name / logo / theme tokens); never
  // exposes secrets, user data or feature configuration.
  '/api/bootstrap',
  // A connector's OAuth provider redirects the BROWSER here, without a Bearer.
  // It writes nothing: it only sends the person back to the app (the client route
  // or the mobile scheme), whose logged-in session then calls
  // POST /api/me/connectors/oauth/finish — which refuses a state started by
  // someone else. Rate-limited in security.ts.
  '/api/connectors/oauth/callback',
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
  // Agent tool proxy validates app/CLI bearer tokens itself and applies its own audit/rate limit.
  if (path.startsWith('/api/agent/')) return true;
  // MCP server uses its own OAuth token auth (bound to an internal user) + audit/rate limit.
  if (path.startsWith('/api/mcp')) return true;
  // Model gateway: authenticated only by a member's `ghgw_` key, with its own rate limit
  // (routes/gateway.ts). The trailing slash matters — nothing else may start `/api/gateway`.
  if (path.startsWith('/api/gateway/')) return true;
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

/** Runs before public SPA hosting as well as authenticated routes. */
export async function extUiScopeMiddleware(c: Context, next: Next) {
  const header = c.req.header('Authorization');
  const embed = header?.startsWith('Bearer ') ? validateExtUiToken(header.slice(7)) : null;
  if (embed && !extUiPathAllowed(embed.plugin, c.req.method, c.req.path))
    return c.json({ error: 'Forbidden: embed token scope' }, 403);
  return next();
}

/**
 * Main auth middleware. Validates token and sets user context.
 * Must be applied globally before any route handlers.
 */
export async function authMiddleware(c: Context, next: Next) {
  // Extract token
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const embed = token ? validateExtUiToken(token) : null;
  if (embed && !extUiPathAllowed(embed.plugin, c.req.method, c.req.path))
    return c.json({ error: 'Forbidden: embed token scope' }, 403);
  if (!embed && isPublicPath(c.req.path)) return next();

  if (!token) {
    return c.json({ error: 'Unauthorized', needsAuth: true }, 401);
  }

  // Validate the signed token, then resolve the current database user. Tokens
  // from deleted, disabled, or former external accounts must not remain usable
  // until their four-hour signature expiry.
  const payload = embed ?? validateAccessToken(token);
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
    if (embed) {
      const { memberCanUsePlugin } = await import('../plugin-host/ui-access.js');
      if (!(await memberCanUsePlugin(getDb(), { id: user.id, role: user.role }, embed.plugin)))
        return c.json({ error: 'Forbidden: plugin unavailable' }, 403);
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
