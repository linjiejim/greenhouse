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
import { resolveProfileAsync } from '../profile.js';
import { resolveEffectiveTools, buildLazyServerTools } from '../agent-runtime/tool-resolution.js';
import {
  resolveProxyToolIds,
  buildProxyManifest,
  executeProxyTool,
  assertWorkspaceAllowed,
  ProxyToolError,
  isMutatingProxyTool,
  prepareProxyToolCall,
} from '../agent-runtime/tool-proxy.js';
import {
  agentBearerAuthMiddleware,
  agentRateLimitMiddleware,
  getAgentIdentity,
  recordAgentAudit,
} from '../agent-runtime/api-auth.js';
import type { AppEnv } from '../app-env.js';
import { pinProfileIdForUser, ProfileAccessError } from '../profile-access.js';
import {
  agentToolAction,
  canonicalAgentToolInput,
  cloudMutationNeedsApproval,
  hashAgentToolInput,
} from '../cloud-agent/approval.js';
import { connectionManager } from '../ws/connection-manager.js';

/**
 * Profile used when a request omits `profile_id`. This route is internal-only
 * and falls back to the canonical agent-runtime profile `desktop`. The proxy
 * still never widens permissions (tools ∩ user-allowed ∩ proxy allowlists).
 */
const DEFAULT_AGENT_PROFILE_ID = 'desktop';
/**
 * Tool inputs are schema-validated after JSON parsing, so the transport must
 * bound the raw body first. Mission task tokens can reach this route directly
 * from the sandbox network without an upstream reverse-proxy limit.
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
      // ── GET /approvals/:approvalId (task token only) ──
      .get('/approvals/:approvalId', async (c) => {
        const identity = getAgentIdentity(c);
        if (identity.credential !== 'task' || !identity.runId) {
          return c.json({ error: { message: 'Run-bound task token required', type: 'auth_error' } }, 403);
        }
        const approval = await getDb().agentRuns.getApprovalById(c.req.param('approvalId'));
        if (!approval || approval.run_id !== identity.runId || approval.user_id !== identity.userId) {
          return c.json({ error: { message: 'Approval not found', type: 'auth_error' } }, 404);
        }
        return c.json({ approval });
      })
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
            approval_id?: string;
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
            const identity = getAgentIdentity(c);
            let confirmed = body.confirm;
            const prepared =
              identity.credential === 'task'
                ? prepareProxyToolCall(ctx.registry, toolId, ctx.toolIds, body.input)
                : null;
            const actualToolId = prepared?.toolId ?? toolId;
            const exactInput = prepared?.input ?? body.input;
            if (identity.credential === 'task' && isMutatingProxyTool(actualToolId)) {
              if (!identity.runId) throw new ProxyToolError('Run-bound task token required', 403);
              if (cloudMutationNeedsApproval(actualToolId, exactInput)) {
                const inputHash = hashAgentToolInput(exactInput);
                if (!body.approval_id) {
                  const approval = await getDb().agentRuns.requestApproval({
                    run_id: identity.runId,
                    user_id: identity.userId,
                    tool_id: actualToolId,
                    action: agentToolAction(exactInput),
                    input_hash: inputHash,
                    input_json: canonicalAgentToolInput(exactInput),
                    ttl_ms: 15 * 60_000,
                  });
                  await recordAgentAudit(c, {
                    endpoint: '/api/agent/tools/:toolId/call',
                    statusCode: 428,
                    durationMs: Date.now() - start,
                    meta: { tool: toolId, approval_id: approval.id, run_id: identity.runId },
                  });
                  const run = await getDb().agentRuns.getRunById(identity.runId);
                  if (run) {
                    connectionManager.sendToUser(identity.userId, {
                      type: 'mission:run',
                      runId: run.id,
                      sessionId: run.session_id,
                      status: run.status,
                    });
                  }
                  return c.json(
                    {
                      error: { message: 'User approval required', type: 'approval_required' },
                      approval: {
                        id: approval.id,
                        run_id: approval.run_id,
                        tool_id: approval.tool_id,
                        action: approval.action,
                        status: approval.status,
                        expires_at: approval.expires_at,
                      },
                    },
                    428,
                  );
                }
                const consumed = await getDb().agentRuns.consumeApproval({
                  id: body.approval_id,
                  run_id: identity.runId,
                  user_id: identity.userId,
                  tool_id: actualToolId,
                  input_hash: inputHash,
                });
                if (!consumed) {
                  throw new ProxyToolError(
                    'Approval is invalid, expired, denied, already used, or bound to other input',
                    403,
                  );
                }
              }
              // A draft exception or a consumed lease is the only way a task
              // token reaches the existing mutation confirmation boundary.
              confirmed = true;
            }
            const output = await executeProxyTool(ctx.registry, toolId, ctx.toolIds, body.input, {
              confirm: confirmed,
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
