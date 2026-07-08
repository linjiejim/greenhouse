/**
 * Auth middleware — token validation + role-based access control.
 *
 * Extracts bearer token from Authorization header, validates it,
 * and injects AuthUser into Hono context via c.set('user', ...).
 *
 * Role middleware factories provide per-route access control.
 */

import type { Context, Next } from 'hono';
import { validateAccessToken, isAuthEnabled } from './token.js';
import type { AuthUser, UserRole } from './token.js';
import { userHasFeature } from './features.js';
import { EXTENSION_PUBLIC_PATHS, EXTENSION_PUBLIC_PATH_PREFIXES } from './extensions.js';

// Re-export for convenience
export type { AuthUser, UserRole };

// ─── Public Paths (skip auth entirely) ───────────────────

const PUBLIC_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/login/external',
  '/api/auth/refresh',
  '/api/auth/status',
  '/health',
  // Pre-login workspace personalization (tenant name/logo/theme/team Sprouty)
  // — no secrets, no user data (see routes/bootstrap.ts).
  '/api/bootstrap',
]);

export function isPublicPath(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) return true;
  // Fork-contributed public paths (empty upstream) — e.g. OAuth callbacks. See auth/extensions.ts.
  if (EXTENSION_PUBLIC_PATHS.includes(path)) return true;
  if (EXTENSION_PUBLIC_PATH_PREFIXES.some((p) => path.startsWith(p))) return true;
  // Frontend static assets — Vite emits the hashed bundle under /assets/* (base './').
  if (path === '/' || path === '/favicon.ico' || path.startsWith('/public/') || path.startsWith('/assets/'))
    return true;
  // Uploaded/generated images — GET /api/upload/:id must be public so browser
  // <img> tags (which can't send an Authorization header) can load them; IDs are
  // unguessable (timestamp + uuid). POST /api/upload (no trailing slash) is NOT
  // matched here, so uploads still require auth via authFetch.
  if (path.startsWith('/api/upload/')) return true;
  // External v1 API uses its own API Key auth (not internal Bearer tokens)
  if (path.startsWith('/api/v1/')) return true;
  // LLM gateway relay uses its own relay-key (API Key) auth, not internal Bearer tokens
  if (path.startsWith('/api/llm/')) return true;
  // Agent tool proxy validates app/CLI bearer tokens itself and applies its own audit/rate limit.
  if (path.startsWith('/api/agent/')) return true;
  // MCP server uses its own API-key auth (key bound to an internal user) + audit/rate limit.
  if (path.startsWith('/api/mcp')) return true;
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
  // Skip if no password configured (dev mode)
  if (!isAuthEnabled()) {
    c.set('user', { id: 'dev', role: 'super', nickname: 'Dev' } as AuthUser);
    return next();
  }

  // Skip public paths
  if (isPublicPath(c.req.path)) return next();

  // Extract token
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return c.json({ error: 'Unauthorized', needsAuth: true }, 401);
  }

  // Validate new format token
  const payload = validateAccessToken(token);
  if (payload) {
    c.set('user', {
      id: payload.uid,
      role: payload.role,
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
 * Require internal user (any non-external role, i.e. super or team).
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
 *   app.use('/api/feature/*', requireInternal());
 *   app.use('/api/feature/*', requireFeature('some_feature'));
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
