/**
 * MCP Server — `/api/mcp`
 *
 * Exposes Greenhouse's internal capability layer to external MCP clients (Claude,
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
 * + skills, plus the protocol-level tool_output_read (pages through a reply too
 * long to return at once — see agent-runtime/tool-output-store.ts). Writes run
 * as the member and are recorded (agent-access/governed-write.ts); every tool
 * carries the standard MCP annotations so clients can ask their user first.
 * Each tool must also be in the proxy READ/WRITE allowlists to be reachable.
 */

import { runWithMeteringScope, type MeteringScope } from '../usage/metering.js';
import { findBudgetRefusal } from '../usage/budget-errors.js';
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
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolRegistry } from '../agent.js';
import { resolveProfileAsync } from '../profiles/profile.js';
import { resolveEffectiveTools, buildLazyServerTools } from '../agent-runtime/tool-resolution.js';
import {
  buildExternalServiceTools,
  externalToolUnavailableMessage,
  listableExternalToolIds,
} from '../agent-runtime/service-tools.js';
// Derived from each tool's `meta.surface.mcp` (tools/registry.ts); re-exported
// for tests/consumers that previously imported the hand-maintained list here.
import { MCP_EXPOSED_TOOL_IDS, getToolMeta } from '../tools/registry.js';
export { MCP_EXPOSED_TOOL_IDS };
import {
  resolveProxyToolIds,
  buildProxyManifest,
  executeProxyTool,
  isMutatingProxyTool,
  canonicalProxyToolId,
  ProxyToolError,
  type ProxyToolManifestEntry,
} from '../agent-runtime/tool-proxy.js';
import { getAgentIdentity } from '../agent-runtime/api-auth.js';
import { governProxyWrite } from '../agent-access/governed-write.js';
import { baseWriteRisk, resolveWriteCaller } from '../agent-access/context.js';
import { writeToolCanDelete, writeToolIsAdditiveOnly } from '../agent-access/risk.js';
import type { AgentIdentity } from '../agent-runtime/api-auth.js';
import { mcpCredentialMiddleware, recordMcpAudit } from '../agent-runtime/mcp-auth.js';
import {
  TOOL_OUTPUT_READ_TOOL,
  ToolOutputNotFoundError,
  boundReplyText,
  readToolOutput,
  toolOutputReadToolDef,
  type ToolOutputCaller,
} from '../agent-runtime/tool-output-store.js';
import type { AppEnv } from '../app-env.js';
import { delegatedAgentActor } from '../platform/actor.js';
import { filterMcpToolIdsByPlatform, MCP_PROFILE_ID } from '../agent-runtime/mcp-tool-visibility.js';
import { dispatchKnowledgeOperation } from '../platform/knowledge/adapter.js';
import {
  KNOWLEDGE_RESOURCE_URI_TEMPLATE,
  listKnowledgeResources,
  readKnowledgeResource,
} from '../platform/knowledge/resources.js';
import { DATA_CATALOG_TOOL, TEAM_CONTEXT_TOOL } from '@greenhouse/types/hub-context';
import { countUsage } from '../usage/counters.js';
import {
  buildTeamContextBundle,
  isContextResourceUri,
  listContextResources,
  readContextResource,
  type TeamContextCaller,
} from '../hub-context/team-context.js';
import { buildDataCatalog } from '../hub-context/catalog.js';
import { getTeamPrompt, listTeamPrompts } from '../hub-context/prompts.js';
import {
  executeMcpCall,
  mcpCallExternalDescription,
  mcpCallInputSchema,
  visibleConnectors,
  MCP_CALL_INPUT_JSON_SCHEMA,
  MCP_CALL_TOOL_ID,
  type McpCallToolContext,
} from '../tools/mcp-call.js';
import { connectorDirectoryVersion } from '../connectors/directory.js';

const SERVER_NAME = 'greenhouse';
const SERVER_VERSION = '0.1.0';

/** Sent to clients in the initialize response — the agent-facing bootstrap hint. */
const SERVER_INSTRUCTIONS =
  'Greenhouse team hub. The tool list is your permission list: a missing tool has not been ' +
  'granted to you, and each tool documents its own usage. You act as the member who connected you, ' +
  'with their permissions, and every write (tools ending in `mutation`) is recorded in their name. ' +
  'Before changing data other people rely on, make sure your user wants that change. A delete first ' +
  'returns {"status":"needs_confirmation",…} and deletes nothing: show it to your user, and only if ' +
  'they agree send the same call again with confirm:true. ' +
  'A result too long for one reply comes back as {"truncated":true,"output_id":…} plus a preview; ' +
  `page through the rest with ${TOOL_OUTPUT_READ_TOOL} only as far as you need. ` +
  `Call ${TEAM_CONTEXT_TOOL} first in a new task: it returns the team's conventions, glossary, ` +
  `prompts and data sources (also readable as greenhouse://context/* resources and MCP prompts); ` +
  `${DATA_CATALOG_TOOL} lists every data source you can query and the tool to use.`;

/** Protocol-level tools: listed for every grant, their content cut to it. */
const TEAM_CONTEXT_TOOL_DEF = {
  name: TEAM_CONTEXT_TOOL,
  description:
    "Call this first in a new task. Returns the team's context in one reply: what this connection can reach, " +
    "the team's conventions and glossary (documents an administrator picked), saved and contributed " +
    'prompts you can use, and a summary of the data sources. Read-only; takes no arguments.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

const DATA_CATALOG_TOOL_DEF = {
  name: DATA_CATALOG_TOOL,
  description:
    'List the data your user can reach through this connection: Tables bases (tables, row counts, owner, last ' +
    'change) and extension data sources, each with the tool and action to query it. Read-only; takes no arguments.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

// Tools exposed over MCP — derived from each tool's `meta.surface.mcp` in the
// catalog (tools/registry.ts). A tool must ALSO carry a proxy tier to be
// reachable. Feature-owned tools are gated by their per-user flag inside
// resolveUserTools — the single flag→tool gate; this route must not re-gate
// (a second hand-written map here once drifted from feature-points.ts).

interface McpContext {
  toolIds: string[];
  registry: ToolRegistry;
}

// The per-request platform visibility rule lives in agent-runtime so other
// surfaces describing the MCP server (the data catalog) ask the same question.
export { filterMcpToolIdsByPlatform };

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
    // A connector added, changed or removed changes what mcp_call lists.
    `connectors@${connectorDirectoryVersion()}`,
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
    ...buildExternalServiceTools(getDb(), effectiveTools, { userId: identity.userId }),
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
 * object JSON Schema. A write tool that can delete also takes an optional
 * `confirm` flag: a delete without it returns a preview and runs nothing.
 */
export function toMcpInputSchema(entry: ProxyToolManifestEntry): Record<string, unknown> {
  const raw = entry.inputSchema;
  const base: Record<string, unknown> =
    raw && typeof raw === 'object' && (raw as { type?: unknown }).type === 'object'
      ? structuredClone(raw)
      : { type: 'object', properties: {}, additionalProperties: true };

  if (entry.mutating && writeToolCanDelete(entry.inputSchema, baseWriteRisk(entry.id))) {
    const properties = { ...((base.properties as Record<string, unknown>) ?? {}) };
    properties.confirm = {
      type: 'boolean',
      description:
        'Only for deletes. Leave it out first: the call returns a preview and deletes nothing. ' +
        'Send true only after your user has seen the preview and agreed.',
    };
    base.properties = properties;
  }
  return base;
}

/** Appended to every write tool's description: the human check lives with the agent. */
const WRITE_TOOL_NOTE =
  ' Runs as the member who connected you and is recorded in their name; before changing data other ' +
  'people rely on, make sure your user wants the change.';

/**
 * Standard MCP tool annotations, so a client can decide when to ask its user:
 * reads are read-only; a write is destructive unless every action it offers
 * only adds something (MCP: false means "only additive updates" — an edit or
 * an archive is not), or the tool declares itself additive (generate_image
 * only ever creates a file). Only tools that declare `surface.openWorld`
 * (the web services, the cloud computer) reach outside Greenhouse.
 */
export function mcpToolAnnotations(entry: ProxyToolManifestEntry) {
  const surface = getToolMeta(entry.id)?.surface;
  const openWorldHint = surface?.openWorld === true;
  if (!entry.mutating) return { readOnlyHint: true, openWorldHint };
  const additive =
    surface?.additiveOnly === true || writeToolIsAdditiveOnly(entry.inputSchema, baseWriteRisk(entry.id));
  return {
    readOnlyHint: false,
    destructiveHint: !additive,
    idempotentHint: false,
    openWorldHint,
  };
}

/**
 * mcp_call reaches other services and may run a remote write or delete (each
 * per its connector's policy), so it is announced as the most cautious kind.
 */
const MCP_CALL_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

/** Build a fresh per-request MCP server wired to this request's tool context. */
export function buildMcpServer(c: Context, ctx: McpContext): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  const identity = getAgentIdentity(c);
  const oauthClientId = c.get('oauthClientId') as string | undefined;
  const oauthAuthMethod = c.get('oauthAuthMethod') as 'oauth' | 'oauth-client' | undefined;
  const actor = delegatedAgentActor({
    userId: identity.userId,
    clientId: oauthClientId,
    authMethod: oauthAuthMethod ?? 'oauth',
  });

  // mcp_call: remote writes need the grant's write scope (and, on a team
  // credential, an administrator's allow_external_writes — see surfaceTools).
  const scopes = (c.get('oauthScopes') as readonly string[] | undefined) ?? [];
  const connectorCtx = (): McpCallToolContext => ({
    db: getDb(),
    userId: identity.userId,
    sessionId: null,
    surface: 'mcp',
    client: 'mcp',
    writesAllowed: scopes.includes('mcp:write'),
    clientId: oauthClientId ?? null,
    clientName: null,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // A cloud-computer tool is not listed at all while the workspace switch is off.
    const entries = buildProxyManifest(await listableExternalToolIds(ctx.toolIds), ctx.registry);
    const tools: Array<Record<string, unknown>> = [];
    for (const entry of entries) {
      if (entry.id === MCP_CALL_TOOL_ID) {
        // Not listed while this member has no connector; the list rides the description.
        if (visibleConnectors(connectorCtx()).length === 0) continue;
        tools.push({
          name: entry.id,
          description: await mcpCallExternalDescription(connectorCtx()),
          inputSchema: MCP_CALL_INPUT_JSON_SCHEMA,
          annotations: MCP_CALL_ANNOTATIONS,
        });
        continue;
      }
      tools.push({
        name: entry.id,
        description: entry.mutating ? `${entry.description}${WRITE_TOOL_NOTE}` : entry.description,
        inputSchema: toMcpInputSchema(entry),
        annotations: mcpToolAnnotations(entry),
      });
    }
    if (entries.length > 0) {
      tools.push({ ...toolOutputReadToolDef(), annotations: { readOnlyHint: true, openWorldHint: false } });
    }
    tools.push(TEAM_CONTEXT_TOOL_DEF, DATA_CATALOG_TOOL_DEF);
    return { tools: tools as never };
  });

  // Team context, prompts and the data catalog: cut to what this grant reaches.
  const reachable: ReadonlySet<string> = new Set(ctx.toolIds);
  const contextCaller = (): TeamContextCaller => ({
    db: getDb(),
    userId: identity.userId,
    role: identity.userRole,
    reachable,
    actor,
  });

  // Metering: every paid call a tool makes is charged to the member and
  // labelled as their agent's (client `mcp` + the OAuth client id).
  const meteringScope: MeteringScope = { userId: identity.userId, client: 'mcp', oauthClientId: oauthClientId ?? null };

  server.setRequestHandler(CallToolRequestSchema, (req) => runWithMeteringScope(meteringScope, () => callTool(req)));

  const callTool = async (req: { params: { name: string; arguments?: Record<string, unknown> } }) => {
    const start = Date.now();
    const name = req.params.name;
    const rawArgs = (req.params.arguments ?? {}) as Record<string, unknown>;
    // Oversized replies are stored per member AND client: only this pair reads them back.
    const outputCaller: ToolOutputCaller = { userId: identity.userId, clientId: oauthClientId ?? 'unknown' };

    try {
      if (name === TOOL_OUTPUT_READ_TOOL) {
        if (ctx.toolIds.length === 0) {
          throw new ProxyToolError(`Tool "${name}" is not available for this credential`, 403);
        }
        // Re-asked on every read: a tool revoked since the call no longer pages out.
        const canUseTool = (toolId: string) => ctx.toolIds.includes(toolId);
        const range = await handleToolOutputRead(outputCaller, rawArgs, canUseTool);
        await recordMcpAudit(c, {
          endpoint: 'mcp:tools/call',
          statusCode: 200,
          durationMs: Date.now() - start,
          meta: { tool: name, output_id: range.output_id, offset: range.offset, returned: range.returned_chars },
        });
        const { text, ...position } = range;
        return {
          content: [
            { type: 'text', text: JSON.stringify(position) },
            { type: 'text', text },
          ],
        };
      }

      if (name === TEAM_CONTEXT_TOOL || name === DATA_CATALOG_TOOL) {
        const output =
          name === TEAM_CONTEXT_TOOL
            ? await buildTeamContextBundle(contextCaller())
            : await buildDataCatalog({ db: getDb(), actor, reachable });
        countUsage('tool_call', name, 'mcp');
        const bounded = await boundReplyText(JSON.stringify(output), outputCaller, name);
        await recordMcpAudit(c, {
          endpoint: 'mcp:tools/call',
          statusCode: 200,
          durationMs: Date.now() - start,
          meta: { tool: name, ...(bounded.outputId ? { output_id: bounded.outputId } : {}) },
        });
        return { content: bounded.content };
      }

      if (name === MCP_CALL_TOOL_ID) {
        if (!ctx.toolIds.includes(name)) {
          throw new ProxyToolError(`Tool "${name}" is not available for this credential`, 403);
        }
        const parsed = mcpCallInputSchema.safeParse(rawArgs);
        if (!parsed.success) throw new ProxyToolError(`Invalid input: ${parsed.error.message}`, 400);
        const client = oauthClientId ? await getDb().platformOAuth.getClient(oauthClientId) : undefined;
        const output = await executeMcpCall(
          { ...connectorCtx(), clientName: client?.client_name ?? null },
          parsed.data,
        );
        const bounded = await boundReplyText(JSON.stringify(output), outputCaller, name);
        const failed = 'error' in output;
        await recordMcpAudit(c, {
          endpoint: 'mcp:tools/call',
          statusCode: 200,
          durationMs: Date.now() - start,
          ...(failed ? { error: 'connector_error' } : {}),
          meta: {
            tool: name,
            action: parsed.data.action,
            ...(parsed.data.connector ? { connector: parsed.data.connector } : {}),
            ...(parsed.data.tool ? { connector_tool: parsed.data.tool } : {}),
            ...(bounded.outputId ? { output_id: bounded.outputId } : {}),
          },
        });
        return { content: bounded.content, ...(failed ? { isError: true } : {}) };
      }

      // A tool this grant reaches but the workspace has switched off (the cloud
      // computer): say why, before anything is recorded, started or charged.
      const unavailable = ctx.toolIds.includes(name) ? await externalToolUnavailableMessage(name) : null;
      if (unavailable) {
        await recordMcpAudit(c, {
          endpoint: 'mcp:tools/call',
          statusCode: 403,
          durationMs: Date.now() - start,
          error: 'unavailable',
          meta: { tool: name },
        });
        return { content: [{ type: 'text', text: unavailable }], isError: true };
      }

      if (isMutatingProxyTool(name)) {
        // `confirm` is ours, not the tool's: strip it before validation.
        const { confirm, ...input } = rawArgs;
        const caller = await resolveWriteCaller(getDb(), {
          userId: identity.userId,
          clientId: oauthClientId ?? 'unknown',
          authMethod: oauthAuthMethod ?? 'oauth',
        });
        const written = await governProxyWrite({
          db: getDb(),
          caller,
          toolId: name,
          input,
          registry: ctx.registry,
          allowedToolIds: ctx.toolIds,
          baseRisk: baseWriteRisk(name),
          confirmed: confirm === true,
        });
        if (written.status === 'needs_confirmation') {
          await recordMcpAudit(c, {
            endpoint: 'mcp:tools/call',
            statusCode: 200,
            durationMs: Date.now() - start,
            meta: { tool: name, write_status: 'needs_confirmation', risk: 'r3' },
          });
          return { content: [{ type: 'text', text: JSON.stringify(written.preview) }] };
        }
        const { view } = written;
        const bounded =
          written.status === 'executed'
            ? await boundReplyText(JSON.stringify(view.output), outputCaller, canonicalProxyToolId(name))
            : null;
        await recordMcpAudit(c, {
          endpoint: 'mcp:tools/call',
          statusCode: written.status === 'executed' ? 200 : written.status === 'failed' ? 422 : 500,
          durationMs: Date.now() - start,
          error: written.status === 'executed' ? undefined : (view.error ?? written.status),
          meta: {
            tool: name,
            write_id: view.request_id,
            write_status: view.status,
            risk: view.risk,
            basis: view.basis,
            ...(bounded?.outputId ? { output_id: bounded.outputId } : {}),
          },
        });
        if (written.status === 'executed') {
          return {
            content: [
              ...(bounded?.content ?? []),
              { type: 'text', text: `Recorded in Greenhouse as write ${view.request_id}.` },
            ],
          };
        }
        if (written.status === 'outcome_unknown') {
          // Not an error to retry: the change may already be in place.
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'outcome_unknown',
                  write_id: view.request_id,
                  message: `${view.error ?? 'The result could not be recorded.'} Check the target before trying again.`,
                }),
              },
            ],
          };
        }
        return { content: [{ type: 'text', text: view.error ?? 'Write failed' }], isError: true };
      }

      const output = await executeProxyTool(ctx.registry, name, ctx.toolIds, rawArgs, {
        usageClient: 'mcp',
        metering: meteringScope,
      });
      const bounded = await boundReplyText(JSON.stringify(output), outputCaller, canonicalProxyToolId(name));
      await recordMcpAudit(c, {
        endpoint: 'mcp:tools/call',
        statusCode: 200,
        durationMs: Date.now() - start,
        meta: { tool: name, ...(bounded.outputId ? { output_id: bounded.outputId } : {}) },
      });
      return { content: bounded.content };
    } catch (err) {
      // Over budget is the agent's to know: its own words, as a tool error.
      const refusal = findBudgetRefusal(err);
      const known = err instanceof ProxyToolError || err instanceof ToolOutputNotFoundError || refusal !== null;
      const status = err instanceof ProxyToolError ? err.status : refusal ? 429 : known ? 404 : 500;
      const message = refusal ? refusal.message : known ? (err as Error).message : 'Tool execution failed';
      if (!known) {
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
  };

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const start = Date.now();
    const context = await listContextResources(contextCaller());
    // Knowledge documents only for a grant that reaches the knowledge tools:
    // resources follow the same resource-group scopes as tools.
    if (!reachable.has('knowledge_query')) {
      await recordMcpAudit(c, { endpoint: 'mcp:resources/list', statusCode: 200, durationMs: Date.now() - start });
      return { resources: context };
    }
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
    return { resources: [...context, ...(result.ok ? result.data.resources : [])] };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    if (!reachable.has('knowledge_query')) return { resourceTemplates: [] };
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
    if (isContextResourceUri(req.params.uri)) {
      const content = await readContextResource(contextCaller(), req.params.uri);
      await recordMcpAudit(c, {
        endpoint: 'mcp:resources/read',
        statusCode: content ? 200 : 404,
        durationMs: Date.now() - start,
        meta: { uri: req.params.uri },
      });
      if (!content) throw new McpError(ErrorCode.InvalidParams, 'Resource not found');
      return { contents: [content] };
    }
    if (!reachable.has('knowledge_query')) {
      await recordMcpAudit(c, {
        endpoint: 'mcp:resources/read',
        statusCode: 404,
        durationMs: Date.now() - start,
        error: 'knowledge not granted',
        meta: { uri: req.params.uri },
      });
      throw new McpError(ErrorCode.InvalidParams, 'Resource not found');
    }
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

  // Prompts: SkillHub skills and the member's saved prompts (hub-context/prompts.ts).
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const start = Date.now();
    const prompts = await listTeamPrompts(getDb(), { userId: identity.userId, role: identity.userRole }, reachable);
    await recordMcpAudit(c, {
      endpoint: 'mcp:prompts/list',
      statusCode: 200,
      durationMs: Date.now() - start,
      meta: { count: prompts.length },
    });
    return { prompts };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const start = Date.now();
    const prompt = await getTeamPrompt(
      getDb(),
      { userId: identity.userId, role: identity.userRole },
      reachable,
      req.params.name,
      req.params.arguments ?? {},
    );
    await recordMcpAudit(c, {
      endpoint: 'mcp:prompts/get',
      statusCode: prompt ? 200 : 404,
      durationMs: Date.now() - start,
      meta: { prompt: req.params.name },
    });
    if (!prompt) throw new McpError(ErrorCode.InvalidParams, `Prompt not found: ${req.params.name}`);
    return { description: prompt.description, messages: prompt.messages };
  });

  return server;
}

async function handleToolOutputRead(
  caller: ToolOutputCaller,
  args: Record<string, unknown>,
  canUseTool: (toolId: string) => boolean,
) {
  const outputId = typeof args.output_id === 'string' ? args.output_id.trim() : '';
  if (!outputId) throw new ProxyToolError('output_id is required', 400);
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  return readToolOutput(caller, { outputId, offset: number(args.offset), limit: number(args.limit) }, canUseTool);
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
