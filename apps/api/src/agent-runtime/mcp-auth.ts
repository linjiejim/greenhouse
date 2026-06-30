/**
 * MCP runtime — auth bridge for `/api/mcp`.
 *
 * External agents authenticate with a long-lived API key (`gh_sk_*`) that is
 * BOUND to an internal user (`api_clients.user_id`). This middleware runs after
 * `apiKeyMiddleware` (which validates the key and injects the `ApiClient`), then:
 *   - requires the key to be bound to a user,
 *   - loads that user and requires an active internal role (`super` | `team`),
 *   - builds the `AgentIdentity` the proxy layer consumes.
 *
 * The bound user's permissions are the security boundary: the proxy can only
 * ever narrow them (tools ∩ allowlist ∩ scope). Mint a least-privilege internal
 * user for each external integration — never bind an MCP key to a super or a
 * personal account.
 */

import type { Context, Next } from 'hono';
import { logger } from '@greenhouse/utils/logger';
import { getDb } from '@greenhouse/db';
import { getApiClient, getClientIP } from '../auth/api-key.js';
import type { AgentIdentity } from './api-auth.js';
import { MUTATING_PROXY_ALLOWLIST } from './tool-proxy.js';

/** Channel recorded for MCP traffic. Reuses the existing `a2a` enum value. */
export const MCP_AUDIT_CHANNEL = 'a2a' as const;

/**
 * Require the API key to be bound to an active internal user and build the
 * `AgentIdentity`. Must run after `apiKeyMiddleware` (which sets `apiClient`).
 *
 * Write posture: the identity carries the full mutating allowlist, so any write
 * the bound user is permitted is reachable — but each call still requires
 * `confirm: true` (see `executeProxyTool`). The real boundary is which user the
 * key binds to.
 */
export async function mcpIdentityMiddleware(c: Context, next: Next) {
  const client = getApiClient(c); // throws if apiKeyMiddleware didn't run

  if (!client.user_id) {
    return c.json(
      {
        error: {
          message: 'This API key is not bound to a user and cannot access the MCP surface',
          type: 'auth_error',
        },
      },
      403,
    );
  }

  let user;
  try {
    user = await getDb().users.getById(client.user_id);
  } catch (err) {
    logger.error('[mcp-auth] user lookup failed:', err);
    return c.json({ error: { message: 'Internal server error', type: 'server_error' } }, 500);
  }

  if (!user || user.status !== 'active') {
    return c.json({ error: { message: 'Bound user is unavailable or disabled', type: 'auth_error' } }, 403);
  }
  if (user.role !== 'super' && user.role !== 'team') {
    return c.json(
      { error: { message: 'MCP access requires an internal user (super or team)', type: 'auth_error' } },
      403,
    );
  }

  const identity: AgentIdentity = {
    userId: user.id,
    userRole: user.role,
    allowedTools: [],
    allowedWriteTools: [...MUTATING_PROXY_ALLOWLIST],
    allowedWorkspaces: [],
  };
  c.set('agentIdentity', identity);
  // Mirror the chat route's context shape so downstream helpers behave identically.
  c.set('user', { id: identity.userId, role: identity.userRole });

  return next();
}

// ─── Audit ─────────────────────────────────────────────────

/**
 * Record an MCP request/tool-call into the shared `api_audit_log`, attributed to
 * the real API client (`app_id`) and the bound internal user (`user_id`).
 */
export async function recordMcpAudit(
  c: Context,
  opts: { endpoint: string; statusCode: number; durationMs: number; error?: string; meta?: Record<string, unknown> },
): Promise<void> {
  try {
    const client = c.get('apiClient') as { app_id?: string } | undefined;
    const identity = c.get('agentIdentity') as AgentIdentity | undefined;
    await getDb().apiAudit.record({
      app_id: client?.app_id ?? 'mcp:unknown',
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
