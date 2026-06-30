/**
 * MCP Server — `/api/mcp`
 *
 * Exposes the internal capability layer to external MCP clients (Claude,
 * Cursor, any MCP-speaking agent) over Streamable HTTP. This is a thin protocol
 * adapter in front of the existing agent tool-proxy — it does NOT define its own
 * resource access:
 *
 *   tools/list  ← buildProxyManifest(...)   (already emits JSON Schema per tool)
 *   tools/call  ← executeProxyTool(...)      (confirm-gate, input validation,
 *                                             permission intersection, all reused)
 *
 * Auth: API key (`gh_sk_*`) bound to an internal user (see mcp-auth.ts). The
 * proxy never widens permissions — the exposed set is always
 *   resolveEffectiveTools(boundUser, profile) ∩ proxy allowlists ∩ MCP phase set.
 *
 * Transport: stateless WebStandard transport (a fresh Server per request). MCP
 * does not enforce an initialize handshake before tools/* on the server, so each
 * self-contained request is answerable without session state.
 *
 * Exposed surface: knowledge + project + email (split read/write, derived from
 * the email_manager grant) + chat history. Each tool must also be in the proxy
 * READ/WRITE allowlists to be reachable.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { logger } from '@greenhouse/utils/logger';
import { getDb } from '@greenhouse/db';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolRegistry } from '../agent.js';
import { resolveProfileAsync } from '../profile.js';
import { resolveEffectiveTools, buildLazyServerTools } from '../agent-runtime/tool-resolution.js';
import {
  resolveProxyToolIds,
  buildProxyManifest,
  executeProxyTool,
  isMutatingProxyTool,
  ProxyToolError,
  type ProxyToolManifestEntry,
} from '../agent-runtime/tool-proxy.js';
import { getAgentIdentity } from '../agent-runtime/api-auth.js';
import { mcpIdentityMiddleware, recordMcpAudit } from '../agent-runtime/mcp-auth.js';
import { apiKeyMiddleware, createPerKeyRateLimitMiddleware } from '../auth/api-key.js';
import { MCP_EXPOSED_TOOL_IDS } from '../tools/registry.js';
import type { AppEnv } from '../app-env.js';

const SERVER_NAME = 'greenhouse';
const SERVER_VERSION = '0.1.0';

/**
 * Profile used to resolve the bound user's tool set. Internal-only surface, so we
 * use the internal `team` profile (an internal-level profile resolves to the
 * bound user's full active tool set), then narrow by the proxy allowlists and the
 * MCP phase set below.
 */
const MCP_PROFILE_ID = 'team';

/**
 * Tools exposed over MCP. DERIVED from each tool's declarative `meta.surface.mcp`
 * field in the tool catalog (apps/api/src/tools/registry.ts) — no hand-maintained
 * id list here. A tool must ALSO be in the proxy READ/WRITE allowlists to be
 * reachable; this set scopes the MCP surface to the shipped domains. Email tools
 * are additionally gated by the user's `email_manager` grant (see resolveMcpContext).
 * Re-exported so existing consumers (mcp.test.ts) keep importing it from this module.
 */
export { MCP_EXPOSED_TOOL_IDS };

interface McpContext {
  toolIds: string[];
  registry: ToolRegistry;
}

/**
 * Email split tools derived from the bound user's `email_manager` grant rather
 * than standalone assignment: a user authorized for the chat email tool gets the
 * same capability (read + confirm-gated send) over MCP, nothing extra to assign.
 */
const EMAIL_TOOL_IDS = ['email_query', 'email_mutation'];

/**
 * Short-TTL cache of the resolved context, keyed by userId+role. The bound user's
 * tools rarely change, so re-resolving (incl. a DB read for team userTools/
 * features) on every tools/list and tools/call is wasteful. TTL is short so
 * permission/feature changes still take effect within ~1 min. Keyed by userId+role
 * only — MCP identities carry no per-key scope or workspace.
 */
const CONTEXT_TTL_MS = 60_000;
const contextCache = new Map<string, { ctx: McpContext; expiresAt: number }>();

/**
 * Resolve the proxy context for the bound user: profile → effective tools →
 * proxy intersection → MCP narrowing, plus the lazy registry. Result is cached per
 * userId+role for CONTEXT_TTL_MS. No workspace scoping (no workspace-bound tool is
 * exposed).
 */
async function resolveMcpContext(c: Context, toolRegistry: ToolRegistry): Promise<McpContext> {
  const identity = getAgentIdentity(c);
  const cacheKey = `${identity.userId}:${identity.userRole}`;
  const cached = contextCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.ctx;

  const profile = await resolveProfileAsync(MCP_PROFILE_ID);
  const { effectiveTools } = await resolveEffectiveTools({
    userId: identity.userId,
    userRole: identity.userRole,
    profile,
    profileId: MCP_PROFILE_ID,
  });

  // Email split tools follow the email_manager grant (binding a mailbox is checked
  // at execute time — an unbound account just gets an empty list_accounts).
  const effective = effectiveTools.includes('email_manager')
    ? [...new Set([...effectiveTools, ...EMAIL_TOOL_IDS])]
    : effectiveTools.filter((id) => !EMAIL_TOOL_IDS.includes(id));

  const toolIds = resolveProxyToolIds(effective, {
    allowedTools: identity.allowedTools,
    allowedWriteTools: identity.allowedWriteTools,
  }).filter((id) => MCP_EXPOSED_TOOL_IDS.has(id));
  const registry: ToolRegistry = {
    ...toolRegistry,
    ...buildLazyServerTools(getDb(), effective, {
      userId: identity.userId,
      userRole: identity.userRole,
      workspaceId: null,
    }),
  };

  const ctx: McpContext = { toolIds, registry };
  contextCache.set(cacheKey, { ctx, expiresAt: Date.now() + CONTEXT_TTL_MS });
  return ctx;
}

/**
 * Convert a proxy manifest entry into an MCP tool input schema. MCP requires an
 * object JSON Schema; mutating tools get a synthetic required `confirm` flag so
 * the agent must consciously opt into each write (see executeProxyTool).
 */
export function toMcpInputSchema(entry: ProxyToolManifestEntry): Record<string, unknown> {
  const raw = entry.inputSchema;
  const base: Record<string, unknown> =
    raw && typeof raw === 'object' && (raw as { type?: unknown }).type === 'object'
      ? structuredClone(raw)
      : { type: 'object', properties: {}, additionalProperties: true };

  if (entry.mutating) {
    const properties = { ...((base.properties as Record<string, unknown>) ?? {}) };
    properties.confirm = {
      type: 'boolean',
      description: 'Must be set to true to execute this state-changing operation.',
    };
    base.properties = properties;
    const required = Array.isArray(base.required) ? (base.required as string[]) : [];
    base.required = Array.from(new Set([...required, 'confirm']));
  }
  return base;
}

/** Build a fresh per-request MCP server wired to this request's tool context. */
export function buildMcpServer(c: Context, ctx: McpContext): Server {
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildProxyManifest(ctx.toolIds, ctx.registry).map((entry) => ({
      name: entry.id,
      description: entry.mutating ? `${entry.description} (write — requires confirm:true)` : entry.description,
      inputSchema: toMcpInputSchema(entry),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const start = Date.now();
    const name = req.params.name;
    const rawArgs = (req.params.arguments ?? {}) as Record<string, unknown>;

    // Pull the synthetic confirm flag out of the args before validation/exec.
    let confirm = false;
    let input: unknown = rawArgs;
    if (isMutatingProxyTool(name)) {
      confirm = rawArgs.confirm === true;
      const { confirm: _omit, ...rest } = rawArgs;
      input = rest;
    }

    try {
      const output = await executeProxyTool(ctx.registry, name, ctx.toolIds, input, { confirm });
      await recordMcpAudit(c, {
        endpoint: 'mcp:tools/call',
        statusCode: 200,
        durationMs: Date.now() - start,
        meta: { tool: name },
      });
      return { content: [{ type: 'text', text: JSON.stringify(output) }] };
    } catch (err) {
      const status = err instanceof ProxyToolError ? err.status : 500;
      const message = err instanceof ProxyToolError ? err.message : 'Tool execution failed';
      if (!(err instanceof ProxyToolError)) logger.error(`[mcp] tool "${name}" failed:`, err);
      await recordMcpAudit(c, {
        endpoint: 'mcp:tools/call',
        statusCode: status,
        durationMs: Date.now() - start,
        error: String(err),
        meta: { tool: name },
      });
      // Surface as a tool error (not a transport failure) so the agent can react.
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  });

  return server;
}

export function createMcpRoutes(toolRegistry: ToolRegistry) {
  return (
    new Hono<AppEnv>()
      // Auth chain: API key → bound-internal-user identity → per-key rate limit.
      .use('*', apiKeyMiddleware)
      .use('*', mcpIdentityMiddleware)
      .use('*', createPerKeyRateLimitMiddleware('mcp'))
      // Single MCP endpoint. POST carries JSON-RPC; GET/DELETE are handled by the
      // transport per spec (405 in stateless mode).
      .all('/', async (c) => {
        let ctx: McpContext;
        try {
          ctx = await resolveMcpContext(c, toolRegistry);
        } catch (err) {
          const status = err instanceof ProxyToolError ? err.status : 500;
          if (!(err instanceof ProxyToolError)) logger.error('[mcp] context resolution failed:', err);
          await recordMcpAudit(c, {
            endpoint: 'mcp:context',
            statusCode: status,
            durationMs: 0,
            error: String(err),
          });
          return c.json(
            { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Failed to resolve MCP context' } },
            status as 400 | 403 | 500,
          );
        }

        const server = buildMcpServer(c, ctx);
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless
          enableJsonResponse: true,
        });
        await server.connect(transport);
        const response = await transport.handleRequest(c.req.raw);
        // Stateless: tear down after the (fully buffered) JSON response is built.
        void server.close();
        return response;
      })
  );
}
