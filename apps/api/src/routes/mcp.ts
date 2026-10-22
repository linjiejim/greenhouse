/**
 * MCP Server — `/api/mcp`
 *
 * Exposes the workbench's internal capability layer to external MCP clients (Claude,
 * Cursor, any MCP-speaking agent) over Streamable HTTP. This is a thin protocol
 * adapter in front of the existing agent tool-proxy — it does NOT define its own
 * resource access:
 *
 *   tools/list  ← buildProxyManifest(...)   (already emits JSON Schema per tool)
 *   tools/call  ← executeProxyTool(...)      (confirm-gate, input validation,
 *                                             permission intersection, all reused)
 *
 * Auth: OAuth 2.1 access token only — authorization code (interactive) or
 * client_credentials (machine clients), see mcp-auth.ts. The proxy never
 * widens permissions — the exposed set is always
 *   resolveEffectiveTools(boundUser, profile) ∩ proxy allowlists ∩ MCP phase set.
 *
 * Transport: stateless WebStandard transport (a fresh Server per request). MCP
 * does not enforce an initialize handshake before tools/* on the server, so each
 * self-contained request is answerable without session state.
 *
 * Exposed surface: knowledge + project + tables (split read/write) + chat history
 * + skills.
 * Each tool must also be in the proxy READ/WRITE allowlists to be reachable.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { logger } from '@greenhouse/utils/logger';
import { getDb } from '@greenhouse/db';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolRegistry } from '../agent.js';
import { resolveProfileAsync } from '../profiles/profile.js';
import { resolveEffectiveTools, buildLazyServerTools } from '../agent-runtime/tool-resolution.js';
// Derived from each tool's `meta.surface.mcp` (tools/registry.ts); re-exported
// for tests/consumers that previously imported the hand-maintained list here.
import { MCP_EXPOSED_TOOL_IDS } from '../tools/registry.js';
export { MCP_EXPOSED_TOOL_IDS };
import {
  resolveProxyToolIds,
  buildProxyManifest,
  executeProxyTool,
  isMutatingProxyTool,
  ProxyToolError,
  type ProxyToolManifestEntry,
} from '../agent-runtime/tool-proxy.js';
import { getAgentIdentity } from '../agent-runtime/api-auth.js';
import {
  AGENT_WRITE_MAX_WAIT_SECONDS,
  AgentWriteError,
  agentWriteStatus,
  governProxyWrite,
  withdrawAgentWrite,
  type AgentWriteView,
} from '../agent-access/governed-write.js';
import { baseWriteRisk, legacyConfirmEnabled, resolveWriteCaller } from '../agent-access/context.js';
import type { AgentIdentity } from '../agent-runtime/api-auth.js';
import { mcpCredentialMiddleware, recordMcpAudit } from '../agent-runtime/mcp-auth.js';
import type { AppEnv } from '../app-env.js';
import { delegatedAgentActor } from '../platform/actor.js';
import { getPlatformRuntime } from '../platform/runtime.js';
import { projectsManifest } from '../platform/manifests/projects.js';
import { knowledgeManifest } from '../platform/manifests/knowledge.js';
import { extensionPlatformToolCapabilities } from '../extensions/boot.js';
import { tablesManifest } from '../platform/manifests/tables.js';
import { dispatchKnowledgeOperation } from '../platform/knowledge/adapter.js';
import {
  KNOWLEDGE_RESOURCE_URI_TEMPLATE,
  listKnowledgeResources,
  readKnowledgeResource,
} from '../platform/knowledge/resources.js';

const SERVER_NAME = 'greenhouse';
const SERVER_VERSION = '0.1.0';

/** Sent to clients in the initialize response — the agent-facing bootstrap hint. */
const SERVER_INSTRUCTIONS =
  'Greenhouse team workbench. The tool list is your permission list: a missing tool has not been ' +
  'granted to you, and each tool documents its own usage. Writes (tools ending in `mutation`) are ' +
  'governed by the member you act for: a write may run at once, or come back as ' +
  '{"status":"needs_approval","request_id":…} — then tell the user, do not resend it, and call ' +
  'agent_write_status with the request_id (wait_seconds up to 30) to get the result. Deletes always ' +
  'need approval. For reusable output skills (decks, reports, reviews…) use skill_query skills.find ' +
  'to search and skills.download to install them locally.';

/** Protocol-level tool every write-capable agent gets; not a catalog tool. */
export const AGENT_WRITE_STATUS_TOOL = 'agent_write_status';

/**
 * Profile used to resolve the bound user's tool set. Internal-only surface, so we
 * use the canonical agent-runtime `desktop` profile (full internal tool set),
 * then narrow by the proxy allowlists and the MCP phase set below.
 */
const MCP_PROFILE_ID = 'desktop';

// Tools exposed over MCP — derived from each tool's `meta.surface.mcp` in the
// catalog (tools/registry.ts). A tool must ALSO carry a proxy tier to be
// reachable. Feature-owned tools are gated by their per-user flag inside
// resolveUserTools — the single flag→tool gate; this route must not re-gate
// (a second hand-written map here once drifted from feature-points.ts).

interface McpContext {
  toolIds: string[];
  registry: ToolRegistry;
}

function capabilitiesByActionKind(
  manifest: typeof projectsManifest | typeof knowledgeManifest | typeof tablesManifest,
  kind: 'query' | 'command',
): string[] {
  return [
    ...new Set(
      Object.values(manifest.actions)
        .filter((action) => action.mcp && action.kind === kind)
        .map((action) => action.capability),
    ),
  ];
}

const PLATFORM_TOOL_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
  project_query: capabilitiesByActionKind(projectsManifest, 'query'),
  project_mutation: capabilitiesByActionKind(projectsManifest, 'command'),
  knowledge_query: capabilitiesByActionKind(knowledgeManifest, 'query'),
  knowledge_mutation: capabilitiesByActionKind(knowledgeManifest, 'command'),
  tables_query: capabilitiesByActionKind(tablesManifest, 'query'),
  tables_mutation: capabilitiesByActionKind(tablesManifest, 'command'),
  // Application-backed tools an extension owns follow the same rule.
  ...extensionPlatformToolCapabilities(capabilitiesByActionKind),
};

/**
 * Registry-migrated tools disappear when none of their actions are authorized.
 * Legacy tools remain governed by their existing feature/tool gates until their
 * M4 migration. This check is intentionally uncached so revocation affects the
 * very next tools/list request.
 */
export async function filterMcpToolIdsByPlatform(
  identity: ReturnType<typeof getAgentIdentity>,
  toolIds: readonly string[],
): Promise<string[]> {
  const actor = delegatedAgentActor({ userId: identity.userId, authMethod: 'oauth' });
  const visibility = await Promise.all(
    toolIds.map(async (toolId) => {
      const capabilities = PLATFORM_TOOL_CAPABILITIES[toolId];
      if (!capabilities) return { toolId, visible: true };
      const decisions = await Promise.all(
        capabilities.map((capability) => getPlatformRuntime().authorize(actor, capability)),
      );
      return { toolId, visible: decisions.some((decision) => decision.allowed) };
    }),
  );
  return visibility.filter((entry) => entry.visible).map((entry) => entry.toolId);
}

/**
 * Short-TTL cache of the built context (lazy-tool registry + narrowed tool ids).
 * The user's effective tool set is re-resolved on EVERY request (two cheap DB
 * reads) and is part of the cache key, so revoking a flag or a user_tools grant
 * takes effect on the very next request — the cache only skips re-constructing
 * the tool registry, never a permission decision. Platform capability visibility
 * and OAuth token/grant/client/user state are never cached either.
 */
const CONTEXT_TTL_MS = 60_000;
const contextCache = new Map<string, { ctx: McpContext; expiresAt: number }>();

/**
 * Compose the MCP context for a resolved identity: profile → effective tools
 * (flag gating included — resolveUserTools is the single gate) → proxy
 * intersection → MCP surface narrowing → per-request platform visibility.
 * Exported so the cross-channel parity test can drive the real composition.
 */
export async function composeMcpContext(identity: AgentIdentity, toolRegistry: ToolRegistry): Promise<McpContext> {
  const profile = await resolveProfileAsync(MCP_PROFILE_ID);
  const { effectiveTools } = await resolveEffectiveTools({
    userId: identity.userId,
    userRole: identity.userRole,
    profile,
    profileId: MCP_PROFILE_ID,
  });

  const cacheKey = [
    identity.userId,
    identity.userRole,
    // `undefined` (no narrowing) and `[]` (nothing readable) must not collide.
    identity.allowedTools ? [...identity.allowedTools].sort().join(',') : '*',
    [...identity.allowedWriteTools].sort().join(','),
    [...effectiveTools].sort().join(','),
  ].join(':');
  const cached = contextCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.ctx, toolIds: await filterMcpToolIdsByPlatform(identity, cached.ctx.toolIds) };
  }

  const toolIds = resolveProxyToolIds(effectiveTools, {
    allowedTools: identity.allowedTools,
    allowedWriteTools: identity.allowedWriteTools,
  }).filter((id) => MCP_EXPOSED_TOOL_IDS.has(id));
  const registry: ToolRegistry = {
    ...toolRegistry,
    ...buildLazyServerTools(getDb(), effectiveTools, {
      userId: identity.userId,
      userRole: identity.userRole,
      workspaceId: null,
    }),
  };

  const ctx: McpContext = { toolIds, registry };
  contextCache.set(cacheKey, { ctx, expiresAt: Date.now() + CONTEXT_TTL_MS });
  return { ...ctx, toolIds: await filterMcpToolIdsByPlatform(identity, toolIds) };
}

/** Resolve the MCP context for the current request's authenticated identity. */
async function resolveMcpContext(c: Context, toolRegistry: ToolRegistry): Promise<McpContext> {
  return composeMcpContext(getAgentIdentity(c), toolRegistry);
}

/**
 * Convert a proxy manifest entry into an MCP tool input schema. MCP requires an
 * object JSON Schema; mutating tools get a synthetic required `confirm` flag so
 * the agent must consciously opt into each write (see executeProxyTool).
 */
export function toMcpInputSchema(
  entry: ProxyToolManifestEntry,
  opts: { legacyConfirm: boolean } = { legacyConfirm: false },
): Record<string, unknown> {
  const raw = entry.inputSchema;
  const base: Record<string, unknown> =
    raw && typeof raw === 'object' && (raw as { type?: unknown }).type === 'object'
      ? structuredClone(raw)
      : { type: 'object', properties: {}, additionalProperties: true };

  // Transition only: while the workspace still honours confirm:true it stays an
  // optional flag, so existing agent prompts keep working. Approval, not this
  // flag, is what governs a write.
  if (entry.mutating && opts.legacyConfirm) {
    const properties = { ...((base.properties as Record<string, unknown>) ?? {}) };
    properties.confirm = {
      type: 'boolean',
      description: 'Optional (legacy). true lets a shared-data write run without asking while the workspace allows it.',
    };
    base.properties = properties;
  }
  return base;
}

/** Build a fresh per-request MCP server wired to this request's tool context. */
export function buildMcpServer(c: Context, ctx: McpContext): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  const identity = getAgentIdentity(c);
  const oauthClientId = c.get('oauthClientId') as string | undefined;
  const oauthAuthMethod = c.get('oauthAuthMethod') as 'oauth' | 'oauth-client' | undefined;
  const actor = delegatedAgentActor({
    userId: identity.userId,
    clientId: oauthClientId,
    authMethod: oauthAuthMethod ?? 'oauth',
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const legacyConfirm = await legacyConfirmEnabled();
    const entries = buildProxyManifest(ctx.toolIds, ctx.registry);
    const tools = entries.map((entry) => ({
      name: entry.id,
      description: entry.mutating
        ? `${entry.description} (write — may need the member's approval; see ${AGENT_WRITE_STATUS_TOOL})`
        : entry.description,
      inputSchema: toMcpInputSchema(entry, { legacyConfirm }),
    }));
    if (entries.some((entry) => entry.mutating)) tools.push(agentWriteStatusToolDef());
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const start = Date.now();
    const name = req.params.name;
    const rawArgs = (req.params.arguments ?? {}) as Record<string, unknown>;

    try {
      if (name === AGENT_WRITE_STATUS_TOOL) {
        if (!ctx.toolIds.some((id) => isMutatingProxyTool(id))) {
          throw new ProxyToolError(`Tool "${name}" is not available for this credential`, 403);
        }
        const result = await handleAgentWriteStatus(c, identity.userId, rawArgs);
        await recordMcpAudit(c, {
          endpoint: 'mcp:tools/call',
          statusCode: 200,
          durationMs: Date.now() - start,
          meta: { tool: name, request_id: result.request_id, write_status: result.status },
        });
        return { content: [{ type: 'text', text: JSON.stringify(agentFacingView(result)) }] };
      }

      if (isMutatingProxyTool(name)) {
        // The legacy confirm flag is ours, not the tool's: strip it before validation.
        const { confirm, ...input } = rawArgs;
        const legacy = confirm === true && (await legacyConfirmEnabled());
        const caller = await resolveWriteCaller(getDb(), {
          userId: identity.userId,
          clientId: oauthClientId ?? 'unknown',
          authMethod: oauthAuthMethod ?? 'oauth',
        });
        const governed = await governProxyWrite({
          db: getDb(),
          caller,
          toolId: name,
          input,
          registry: ctx.registry,
          allowedToolIds: ctx.toolIds,
          baseRisk: baseWriteRisk(name),
          legacyConfirm: legacy,
        });
        await recordMcpAudit(c, {
          endpoint: 'mcp:tools/call',
          statusCode: governed.status === 'failed' ? 422 : governed.status === 'needs_approval' ? 202 : 200,
          durationMs: Date.now() - start,
          error: governed.status === 'failed' ? (governed.view.error ?? 'failed') : undefined,
          meta: {
            tool: name,
            request_id: governed.view.request_id,
            write_status: governed.view.status,
            risk: governed.view.risk,
            basis: governed.view.basis,
          },
        });
        if (governed.status === 'executed') {
          return {
            content: [
              { type: 'text', text: JSON.stringify(governed.view.output) },
              {
                type: 'text',
                text: `Recorded as Greenhouse request ${governed.view.request_id} (${governed.view.basis}).`,
              },
            ],
          };
        }
        if (governed.status === 'failed') {
          return { content: [{ type: 'text', text: governed.view.error ?? 'Write failed' }], isError: true };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                agentFacingView(governed.view, governed.status === 'needs_approval' && governed.reused),
              ),
            },
          ],
        };
      }

      const output = await executeProxyTool(ctx.registry, name, ctx.toolIds, rawArgs);
      await recordMcpAudit(c, {
        endpoint: 'mcp:tools/call',
        statusCode: 200,
        durationMs: Date.now() - start,
        meta: { tool: name },
      });
      return { content: [{ type: 'text', text: JSON.stringify(output) }] };
    } catch (err) {
      const status = err instanceof ProxyToolError ? err.status : err instanceof AgentWriteError ? 404 : 500;
      const message =
        err instanceof ProxyToolError || err instanceof AgentWriteError ? err.message : 'Tool execution failed';
      if (!(err instanceof ProxyToolError) && !(err instanceof AgentWriteError)) {
        logger.error(`[mcp] tool "${name}" failed:`, err);
      }
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

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const start = Date.now();
    const result = await dispatchKnowledgeOperation(
      actor,
      'listDocuments',
      { transport: 'mcp-resource' },
      async () => ({
        ok: true,
        data: {
          resources: await listKnowledgeResources(getDb(), identity.userId),
        },
      }),
    );
    await recordMcpAudit(c, {
      endpoint: 'mcp:resources/list',
      statusCode: result.ok ? 200 : 403,
      durationMs: Date.now() - start,
      error: result.ok ? undefined : result.message,
    });
    return result.ok ? result.data : { resources: [] };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const result = await dispatchKnowledgeOperation(
      actor,
      'listDocuments',
      { transport: 'mcp-resource-template' },
      async () => ({
        ok: true,
        data: {
          resourceTemplates: [
            {
              name: 'knowledge-document',
              title: 'Knowledge document',
              description: 'A team, personal, or explicitly shared knowledge document.',
              uriTemplate: KNOWLEDGE_RESOURCE_URI_TEMPLATE,
              mimeType: 'text/markdown',
            },
          ],
        },
      }),
    );
    return result.ok ? result.data : { resourceTemplates: [] };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const start = Date.now();
    const result = await dispatchKnowledgeOperation(
      actor,
      'readDocument',
      { uri: req.params.uri, transport: 'mcp-resource' },
      async () => {
        const content = await readKnowledgeResource(getDb(), identity.userId, req.params.uri);
        return content
          ? { ok: true, data: { contents: [content] } }
          : { ok: false, code: 'NOT_FOUND', message: 'Resource not found' };
      },
    );
    await recordMcpAudit(c, {
      endpoint: 'mcp:resources/read',
      statusCode: result.ok ? 200 : result.code === 'FORBIDDEN' ? 403 : 404,
      durationMs: Date.now() - start,
      error: result.ok ? undefined : result.message,
      meta: { uri: req.params.uri },
    });
    if (!result.ok) throw new McpError(ErrorCode.InvalidParams, 'Resource not found');
    return result.data;
  });

  return server;
}

function agentWriteStatusToolDef() {
  return {
    name: AGENT_WRITE_STATUS_TOOL,
    description:
      'Check a write that needed approval. Pass the request_id you were given; wait_seconds (0–30) waits for the ' +
      "member's decision. action=withdraw cancels a request still waiting. Statuses: pending, executed (output " +
      'holds the tool result), failed, rejected, expired, withdrawn, superseded, outcome_unknown.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: 'The request_id from a needs_approval result.' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: AGENT_WRITE_MAX_WAIT_SECONDS },
        action: { type: 'string', enum: ['status', 'withdraw'], default: 'status' },
      },
      required: ['request_id'],
      additionalProperties: false,
    },
  };
}

async function handleAgentWriteStatus(c: Context, userId: string, args: Record<string, unknown>) {
  const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : '';
  if (!requestId) throw new ProxyToolError('request_id is required', 400);
  const caller = { userId, clientId: (c.get('oauthClientId') as string | undefined) ?? 'unknown' };
  if (args.action === 'withdraw') return withdrawAgentWrite(getDb(), requestId, caller);
  const wait = typeof args.wait_seconds === 'number' && Number.isFinite(args.wait_seconds) ? args.wait_seconds : 0;
  return agentWriteStatus(getDb(), requestId, caller, wait);
}

/** What the calling agent sees: enough to act on, without internal ids it cannot use. */
function agentFacingView(view: AgentWriteView, reused = false) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const pending = view.status === 'pending';
  return {
    status: pending ? 'needs_approval' : view.status,
    request_id: view.request_id,
    tool: view.tool_id,
    action: view.action,
    risk: view.risk,
    ...(pending
      ? {
          message:
            (reused ? 'This same write is already waiting for approval. ' : '') +
            "This write needs the member's approval in Greenhouse (Settings → Agent connections). Tell the user, do " +
            `not resend it, and call ${AGENT_WRITE_STATUS_TOOL} with this request_id to get the result.`,
          approve_url: `${base}/#/settings/agent-connections/requests/${encodeURIComponent(view.request_id)}`,
          expires_at: view.expires_at,
        }
      : {}),
    ...(view.status === 'executed' ? { output: view.output } : {}),
    ...(view.error && !pending ? { error: view.error } : {}),
  };
}

export function createMcpRoutes(toolRegistry: ToolRegistry) {
  return (
    new Hono<AppEnv>()
      // OAuth or legacy API key → current internal-user identity → scoped rate limit.
      .use('*', mcpCredentialMiddleware)
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
