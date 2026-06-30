/**
 * Agent runtime — user bearer auth, per-user rate limiting, and audit for `/api/agent/*`.
 *
 * Local Agent / CLI cloud access now reuses the logged-in user's access token.
 * There is no separate long-lived `local-agent` API key surface for this route.
 * The proxy still never widens permissions: downstream resolution uses the same
 * user role/profile/tool model as `/api/chat`, plus the proxy allowlists.
 */

import type { Context, Next } from 'hono';
import { logger } from '@greenhouse/utils/logger';
import { getDb } from '@greenhouse/db';
import type { UserRole } from '@greenhouse/db';
import { validateAccessToken, isAuthEnabled } from '../auth/token.js';
import { getClientIP } from '../auth/api-key.js';
import { InMemoryRateLimiter } from '../security.js';
import { MUTATING_PROXY_ALLOWLIST } from './tool-proxy.js';

const AGENT_RPM_LIMIT = 30;
const AGENT_RPD_LIMIT = 1000;
const agentLimiter = new InMemoryRateLimiter(120_000);

/** Resolved identity of the logged-in user for the current agent request. */
export interface AgentIdentity {
  userId: string;
  userRole: UserRole;
  /** Extra READ narrowing. Empty means all proxy read tools allowed by the user's effective tools. */
  allowedTools: string[];
  /** WRITE tools available to logged-in CLI users. Each call still requires `confirm:true`. */
  allowedWriteTools: string[];
  /** Extra workspace narrowing. Empty means no additional narrowing beyond tool/user permissions. */
  allowedWorkspaces: string[];
}

function tokenFromHeader(c: Context): string | null {
  const authHeader = c.req.header('Authorization');
  return authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
}

function setAgentIdentity(c: Context, identity: AgentIdentity): void {
  c.set('agentIdentity', identity);
  // Mirror the chat route's context shape so downstream helpers behave identically.
  c.set('user', { id: identity.userId, role: identity.userRole });
}

function identityFor(userId: string, userRole: UserRole): AgentIdentity {
  return {
    userId,
    userRole,
    allowedTools: [],
    allowedWriteTools: [...MUTATING_PROXY_ALLOWLIST],
    allowedWorkspaces: [],
  };
}

export function getAgentIdentity(c: Context): AgentIdentity {
  const identity = c.get('agentIdentity') as AgentIdentity | undefined;
  if (!identity) throw new Error('getAgentIdentity called without agentBearerAuthMiddleware');
  return identity;
}

/**
 * Authenticate `/api/agent/*` with the same access token used by the app/CLI.
 * External users are rejected; internal users get their current DB role/status.
 */
export async function agentBearerAuthMiddleware(c: Context, next: Next) {
  if (!isAuthEnabled()) {
    setAgentIdentity(c, identityFor('dev', 'super'));
    return next();
  }

  const token = tokenFromHeader(c);
  if (!token) {
    return c.json(
      {
        error: {
          message: 'Missing or invalid Authorization header. Use: Authorization: Bearer <access_token>',
          type: 'auth_error',
        },
      },
      401,
    );
  }

  const payload = validateAccessToken(token);
  if (!payload) {
    return c.json({ error: { message: 'Invalid or expired access token', type: 'auth_error' } }, 401);
  }

  if (payload.role === 'external') {
    return c.json({ error: { message: 'Agent runtime requires an internal user', type: 'auth_error' } }, 403);
  }

  // Internal service tokens are intentionally short-lived and trusted.
  if (payload.uid === 'internal') {
    setAgentIdentity(c, identityFor(payload.uid, payload.role));
    return next();
  }

  let user;
  try {
    user = await getDb().users.getById(payload.uid);
  } catch (err) {
    logger.error('[agent-auth] user lookup failed:', err);
    return c.json({ error: { message: 'Internal server error', type: 'server_error' } }, 500);
  }

  if (!user || user.status !== 'active') {
    return c.json({ error: { message: 'User is unavailable or disabled', type: 'auth_error' } }, 403);
  }
  if (user.role === 'external') {
    return c.json({ error: { message: 'Agent runtime requires an internal user', type: 'auth_error' } }, 403);
  }

  setAgentIdentity(c, identityFor(user.id, user.role));
  return next();
}

// ─── Per-user rate limiting ────────────────────────────────────────────────

export async function agentRateLimitMiddleware(c: Context, next: Next) {
  const identity = getAgentIdentity(c);
  const baseKey = `agent:${identity.userId}`;

  const rpm = agentLimiter.check(`${baseKey}:rpm`, 60_000, AGENT_RPM_LIMIT);
  c.header('X-RateLimit-Limit', String(AGENT_RPM_LIMIT));
  c.header('X-RateLimit-Remaining', String(Math.max(0, rpm.remaining)));
  c.header('X-RateLimit-Reset', String(Math.ceil(rpm.resetAt / 1000)));
  if (!rpm.allowed) {
    return c.json({ error: { message: 'Rate limit exceeded (requests per minute)', type: 'rate_limit_error' } }, 429);
  }

  const rpd = agentLimiter.check(`${baseKey}:rpd`, 86_400_000, AGENT_RPD_LIMIT);
  if (!rpd.allowed) {
    return c.json({ error: { message: 'Rate limit exceeded (requests per day)', type: 'rate_limit_error' } }, 429);
  }

  return next();
}

// ─── Audit ─────────────────────────────────────────────────

export async function recordAgentAudit(
  c: Context,
  opts: { endpoint: string; statusCode: number; durationMs: number; error?: string; meta?: Record<string, unknown> },
): Promise<void> {
  try {
    const identity = c.get('agentIdentity') as AgentIdentity | undefined;
    const userId = identity?.userId ?? 'unknown';
    await getDb().apiAudit.record({
      app_id: `agent:${userId}`,
      endpoint: opts.endpoint,
      method: c.req.method,
      user_id: identity?.userId,
      channel: 'cli',
      status_code: opts.statusCode,
      duration_ms: opts.durationMs,
      meta: opts.meta,
      ip_address: getClientIP(c),
      error: opts.error,
    });
  } catch (err) {
    logger.error('[agent-auth] failed to record audit:', err);
  }
}
