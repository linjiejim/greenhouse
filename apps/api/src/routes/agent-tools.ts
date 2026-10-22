/**
 * Agent Tool Proxy — /api/agent/*
 *
 * Stable cloud capability layer for authenticated Agent integrations and CLI.
 *
 *   GET  /api/agent/runtime-manifest?profile_id=&workspace_id=
 *   POST /api/agent/tools/:toolId/call
 *
 * Auth: logged-in user access token (Authorization: Bearer <access_token>).
 * Tool set: resolveEffectiveTools(user, profile) ∩ proxy allowlists.
 * The proxy can only ever narrow the user's own permissions, never widen them.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { logger } from '@greenhouse/utils/logger';
import { getDb } from '@greenhouse/db';
import type { ToolRegistry } from '../agent.js';
import { resolveProfileAsync } from '../profiles/profile.js';
import { resolveEffectiveTools, buildLazyServerTools } from '../agent-runtime/tool-resolution.js';
import {
  resolveProxyToolIds,
  buildProxyManifest,
  executeProxyTool,
  assertWorkspaceAllowed,
  ProxyToolError,
} from '../agent-runtime/tool-proxy.js';
import {
  agentBearerAuthMiddleware,
  agentRateLimitMiddleware,
  getAgentIdentity,
  recordAgentAudit,
} from '../agent-runtime/api-auth.js';
import type { AppEnv } from '../app-env.js';
import { pinProfileIdForUser, ProfileAccessError } from '../profiles/access.js';
import { agentApiToolCallClient, requestAppClient } from '../usage/counters.js';

/**
 * Profile used when a request omits `profile_id`. This route is internal-only
 * and falls back to the canonical agent-runtime profile `desktop`. The proxy
 * still never widens permissions (tools ∩ user-allowed ∩ proxy allowlists).
 */
const DEFAULT_AGENT_PROFILE_ID = 'desktop';
/**
 * Tool inputs are schema-validated after JSON parsing, so the transport must
 * bound the raw body first.
 */
export const MAX_AGENT_TOOL_BODY_BYTES = 2 * 1024 * 1024;

/** The shared per-request proxy context both endpoints derive. */
interface ProxyContext {
  /** Tool IDs reachable for this (user, profile, key) after every intersection. */
  toolIds: string[];
  /** Live registry (base + per-request lazy server tools) for schema derivation + execution. */
  registry: ToolRegistry;
}

export function createAgentRoutes(toolRegistry: ToolRegistry) {
  /**
   * Resolve the proxy context shared by both endpoints: enforce the key's
   * workspace scope, resolve the profile, intersect tools, and assemble the
   * per-request registry. Throws ProxyToolError(400) for an invalid profile and
   * ProxyToolError(403) for a workspace the key may not access.
   */
  async function resolveProxyContext(c: Context, profileId: string, workspaceId: string | null): Promise<ProxyContext> {
    const identity = getAgentIdentity(c);
    assertWorkspaceAllowed(identity.allowedWorkspaces, workspaceId);

    let pinnedProfileId: string;
    try {
      pinnedProfileId = await pinProfileIdForUser({ id: identity.userId, role: identity.userRole }, profileId);
    } catch (err) {
      if (err instanceof ProfileAccessError) throw new ProxyToolError(err.message, err.status);
      throw err;
    }

    let profile;
    try {
      profile = await resolveProfileAsync(pinnedProfileId);
    } catch (err) {
      throw new ProxyToolError(`Invalid profile: ${err instanceof Error ? err.message : err}`, 400);
    }

    const { effectiveTools } = await resolveEffectiveTools({
      userId: identity.userId,
      userRole: identity.userRole,
      profile,
      profileId: pinnedProfileId,
    });
    const toolIds = resolveProxyToolIds(effectiveTools, {
      allowedTools: identity.allowedTools,
      allowedWriteTools: identity.allowedWriteTools,
    });
    const registry: ToolRegistry = {
      ...toolRegistry,
      ...buildLazyServerTools(getDb(), effectiveTools, {
        userId: identity.userId,
        userRole: identity.userRole,
        workspaceId,
        lockWorkspace: true,
      }),
    };
    return { toolIds, registry };
  }

  /** Map a ProxyToolError (or unexpected error) to a JSON response + audit row. */
  async function respondProxyError(
    c: Context,
    err: unknown,
    o: { endpoint: string; start: number; meta?: Record<string, unknown> },
  ) {
    if (err instanceof ProxyToolError) {
      await recordAgentAudit(c, {
        endpoint: o.endpoint,
        statusCode: err.status,
        durationMs: Date.now() - o.start,
        error: err.message,
        meta: o.meta,
      });
      return c.json(
        { error: { message: err.message, type: err.status === 403 ? 'auth_error' : 'invalid_request_error' } },
        err.status as 400 | 403 | 404,
      );
    }
    logger.error(`[agent] ${o.endpoint} failed:`, err);
    await recordAgentAudit(c, {
      endpoint: o.endpoint,
      statusCode: 500,
      durationMs: Date.now() - o.start,
      error: String(err),
      meta: o.meta,
    });
    return c.json({ error: { message: 'Internal server error', type: 'server_error' } }, 500);
  }

  return (
    new Hono<AppEnv>()
      // Auth chain: app/CLI access token → per-user rate limit.
      .use('*', agentBearerAuthMiddleware)
      .use('*', agentRateLimitMiddleware)
      // ── GET /runtime-manifest ──
      .get('/runtime-manifest', async (c) => {
        const start = Date.now();
        const profileId = c.req.query('profile_id') || DEFAULT_AGENT_PROFILE_ID;
        const workspaceId = c.req.query('workspace_id') || null;

        let ctx: ProxyContext;
        try {
          ctx = await resolveProxyContext(c, profileId, workspaceId);
        } catch (err) {
          return respondProxyError(c, err, {
            endpoint: '/api/agent/runtime-manifest',
            start,
            meta: { profile_id: profileId },
          });
        }

        await recordAgentAudit(c, {
          endpoint: '/api/agent/runtime-manifest',
          statusCode: 200,
          durationMs: Date.now() - start,
          meta: { profile_id: profileId, tool_count: ctx.toolIds.length },
        });

        return c.json({
          profile_id: profileId,
          workspace_id: workspaceId,
          tools: buildProxyManifest(ctx.toolIds, ctx.registry),
          capabilities: { serverTools: true, localTools: false },
        });
      })
      // ── POST /tools/:toolId/call ──
      .post(
        '/tools/:toolId/call',
        bodyLimit({
          maxSize: MAX_AGENT_TOOL_BODY_BYTES,
          onError: (c) =>
            c.json({ error: { message: 'Request body is too large', type: 'invalid_request_error' } }, 413),
        }),
        async (c) => {
          const start = Date.now();
          const toolId = c.req.param('toolId');

          let body: {
            input?: unknown;
            profile_id?: string;
            workspace_id?: string;
            confirm?: boolean;
          };
          try {
            body = (await c.req.json()) as typeof body;
          } catch {
            return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400);
          }

          const profileId = body.profile_id || DEFAULT_AGENT_PROFILE_ID;
          const workspaceId = body.workspace_id || null;

          let ctx: ProxyContext;
          try {
            ctx = await resolveProxyContext(c, profileId, workspaceId);
          } catch (err) {
            return respondProxyError(c, err, {
              endpoint: '/api/agent/tools/:toolId/call',
              start,
              meta: { tool: toolId, profile_id: profileId },
            });
          }

          try {
            const output = await executeProxyTool(ctx.registry, toolId, ctx.toolIds, body.input, {
              confirm: body.confirm,
              usageClient: agentApiToolCallClient(requestAppClient(c)),
            });
            await recordAgentAudit(c, {
              endpoint: '/api/agent/tools/:toolId/call',
              statusCode: 200,
              durationMs: Date.now() - start,
              meta: { tool: toolId, profile_id: profileId },
            });
            return c.json({ tool: toolId, output });
          } catch (err) {
            if (err instanceof ProxyToolError) {
              return respondProxyError(c, err, {
                endpoint: '/api/agent/tools/:toolId/call',
                start,
                meta: { tool: toolId },
              });
            }
            logger.error(`[agent] tool "${toolId}" execution failed:`, err);
            await recordAgentAudit(c, {
              endpoint: '/api/agent/tools/:toolId/call',
              statusCode: 500,
              durationMs: Date.now() - start,
              error: String(err),
              meta: { tool: toolId },
            });
            return c.json({ error: { message: 'Tool execution failed', type: 'server_error' } }, 500);
          }
        },
      )
  );
}
