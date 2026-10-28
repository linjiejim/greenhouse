/**
 * Agent runtime — cloud tool proxy.
 *
 * Exposes a curated subset of server tools to trusted integrations (Agent API,
 * CLI) via `/api/agent/*`.
 *
 * Two tiers:
 * - READ tools (READONLY_PROXY_ALLOWLIST): exposed for eligible internal users.
 * - WRITE tools (MUTATING_PROXY_ALLOWLIST): default-DENY unless the caller's
 *   auth scope includes them, and each call must pass `confirm: true`.
 *   Only unambiguously-mutating, bounded tools are listed here; mixed read/write
 *   tools (e.g. feature_request, memory) need per-action gating and are
 *   intentionally excluded. Domain tools ship as split read/write pairs
 *   (crm_query/crm_mutation, …) so each side lands cleanly in one tier.
 *
 * The proxy never widens permissions: the exposed set is always
 *   resolveEffectiveTools(user, profile) ∩ proxy allowlists.
 */

import { z } from 'zod';
import { logger } from '@greenhouse/utils/logger';
import type { ToolCallClient } from '@greenhouse/types/usage';
import type { ToolRegistry } from '../agent.js';
import { getToolMeta } from '../tools/registry.js';
import { runWithMeteringScope, type MeteringScope } from '../usage/metering.js';
import { countUsage } from '../usage/counters.js';

import { READONLY_PROXY_ALLOWLIST, MUTATING_PROXY_ALLOWLIST } from '../tools/registry.js';

// Derived from each tool's declarative `meta.surface` in the catalog (single
// source; guard test pins the sets). Re-exported here so existing consumers
// (api-auth, mcp-auth, routes) keep their import path.
export { READONLY_PROXY_ALLOWLIST, MUTATING_PROXY_ALLOWLIST };

/**
 * Server tools considered safe to expose read-only through the proxy.
 * Default-deny: anything not listed here is never reachable via /api/agent.
 */

export function isMutatingProxyTool(id: string): boolean {
  return MUTATING_PROXY_ALLOWLIST.has(id);
}

export interface ProxyToolManifestEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  /** Whether the tool mutates state (requires confirm:true to call). */
  mutating: boolean;
  /** JSON Schema for the tool input, when derivable from its (Zod) schema. */
  inputSchema?: Record<string, unknown>;
}

/**
 * Best-effort conversion of a tool's `inputSchema` to JSON Schema so agents can
 * construct valid calls. Returns undefined for non-Zod schemas or on failure.
 */
function toInputJsonSchema(toolId: string, registry?: ToolRegistry): Record<string, unknown> | undefined {
  const schema = (registry?.[toolId] as { inputSchema?: unknown } | undefined)?.inputSchema;
  if (!schema) return undefined;
  try {
    // Zod v4 schemas carry a `_zod` brand; z.toJSONSchema handles them.
    if (typeof schema === 'object' && schema !== null && '_zod' in schema) {
      return z.toJSONSchema(schema as unknown as z.ZodType) as Record<string, unknown>;
    }
    // Already a plain JSON schema object (AI SDK jsonSchema() helper).
    if (typeof schema === 'object' && schema !== null && 'jsonSchema' in schema) {
      return (schema as { jsonSchema: Record<string, unknown> }).jsonSchema;
    }
  } catch (err) {
    logger.warn(`[agent] could not derive JSON schema for tool "${toolId}": ${String(err)}`);
  }
  return undefined;
}

export interface ProxyScopeOptions {
  /**
   * Extra READ narrowing. `undefined` = no narrowing beyond the proxy allowlist;
   * a list narrows to exactly it, and an EMPTY list means zero read tools.
   * MCP passes the tools of the granted resource groups here, so treating empty
   * as "no narrowing" would silently turn the narrowest possible grant into an
   * unrestricted one.
   */
  allowedTools?: string[];
  /** WRITE tools allowed for this credential; empty/undefined = no writes. */
  allowedWriteTools?: string[];
}

/**
 * Compute the proxy-exposable tool IDs for a request.
 *
 * Read tools: effectiveTools ∩ READONLY_PROXY_ALLOWLIST ∩ optional read scope.
 * Write tools: effectiveTools ∩ MUTATING_PROXY_ALLOWLIST ∩ optional write scope
 *   (and every write execution still requires confirm:true).
 */
export function resolveProxyToolIds(effectiveTools: string[], opts: ProxyScopeOptions = {}): string[] {
  const readScope = opts.allowedTools ? new Set(opts.allowedTools) : null;
  const writeScope = new Set(opts.allowedWriteTools ?? []);
  const reads = effectiveTools.filter((id) => READONLY_PROXY_ALLOWLIST.has(id) && (!readScope || readScope.has(id)));
  const writes = effectiveTools.filter((id) => MUTATING_PROXY_ALLOWLIST.has(id) && writeScope.has(id));
  return [...reads, ...writes];
}

/**
 * Build the agent-facing manifest entries for a set of tool IDs.
 *
 * @param registry - optional live tool registry; when provided, each entry
 *   includes a JSON Schema for its input (so agents can construct valid calls).
 */
export function buildProxyManifest(toolIds: string[], registry?: ToolRegistry): ProxyToolManifestEntry[] {
  const entries: ProxyToolManifestEntry[] = [];
  for (const id of toolIds) {
    const meta = getToolMeta(id);
    if (!meta) continue;
    const inputSchema = toInputJsonSchema(id, registry);
    entries.push({
      id,
      name: meta.name,
      description: meta.description,
      category: meta.category,
      mutating: isMutatingProxyTool(id),
      inputSchema,
    });
  }
  return entries;
}

export class ProxyToolError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ProxyToolError';
    this.status = status;
  }
}

/**
 * Enforce an optional workspace allowlist.
 *
 * - Empty allowlist → the credential is not workspace-scoped; any workspace is allowed.
 * - Non-empty allowlist → a workspace is mandatory and must be in it. Tool
 *   inputs are separately locked to that outer workspace by the route.
 *
 * @throws ProxyToolError(403) when a workspace is requested but not permitted.
 */
export function assertWorkspaceAllowed(allowedWorkspaces: string[], workspaceId: string | null | undefined): void {
  if (allowedWorkspaces.length === 0) return;
  if (!workspaceId) {
    throw new ProxyToolError('A workspace is required for this scoped credential', 403);
  }
  if (!allowedWorkspaces.includes(workspaceId)) {
    throw new ProxyToolError(`Workspace "${workspaceId}" is not permitted for this credential`, 403);
  }
}

export interface PreparedProxyToolCall {
  toolId: string;
  input: unknown;
  execute: (input: unknown, options: unknown) => Promise<unknown>;
}

/** Validate reachability, implementation and schema without executing. */
export function prepareProxyToolCall(
  registry: ToolRegistry,
  toolId: string,
  allowedToolIds: string[],
  input: unknown,
): PreparedProxyToolCall {
  if (!allowedToolIds.includes(toolId)) {
    throw new ProxyToolError(`Tool "${toolId}" is not available for this credential`, 403);
  }
  const toolDef = registry[toolId] as
    | {
        inputSchema?: { safeParse?: (v: unknown) => { success: boolean; data?: unknown; error?: unknown } };
        execute?: (input: unknown, options: unknown) => Promise<unknown>;
      }
    | undefined;
  if (!toolDef || typeof toolDef.execute !== 'function') {
    throw new ProxyToolError(`Tool "${toolId}" has no executable implementation`, 404);
  }

  let validatedInput = input;
  if (toolDef.inputSchema && typeof toolDef.inputSchema.safeParse === 'function') {
    const result = toolDef.inputSchema.safeParse(input ?? {});
    if (!result.success) {
      throw new ProxyToolError(`Invalid input for tool "${toolId}": ${formatZodError(result.error)}`, 400);
    }
    validatedInput = result.data;
  }
  return { toolId, input: validatedInput, execute: toolDef.execute };
}

/**
 * Execute a proxied tool by ID.
 *
 * Validates the tool is reachable for this request, validates the input against
 * the tool's schema when available, then runs its `execute`.
 *
 * @throws ProxyToolError(403) if the tool is not in the allowed set
 * @throws ProxyToolError(400) if a mutating tool is called without confirm:true, or input fails validation
 * @throws ProxyToolError(404) if the tool has no executable implementation
 *
 * `metering` is the attribution of any paid call the tool makes (the member,
 * the client, the agent's OAuth client) — see usage/metering.ts.
 *
 * `usageClient` counts one `tool_call` (fire-and-forget) once every check has
 * passed, keyed by the tool id; omit it for internal evaluations
 * that are not a client calling a tool.
 */
export async function executeProxyTool(
  registry: ToolRegistry,
  toolId: string,
  allowedToolIds: string[],
  input: unknown,
  opts: { confirm?: boolean; usageClient?: ToolCallClient; metering?: MeteringScope } = {},
): Promise<unknown> {
  if (!allowedToolIds.includes(toolId)) {
    throw new ProxyToolError(`Tool "${toolId}" is not available for this credential`, 403);
  }

  // Mutating tools require explicit per-call confirmation.
  if (isMutatingProxyTool(toolId) && opts.confirm !== true) {
    throw new ProxyToolError(`Tool "${toolId}" mutates state — pass confirm:true to execute`, 400);
  }

  const prepared = prepareProxyToolCall(registry, toolId, allowedToolIds, input);
  if (opts.usageClient) countUsage('tool_call', prepared.toolId, opts.usageClient);
  const run = () => prepared.execute(prepared.input, { toolCallId: `agent-proxy-${toolId}`, messages: [] });
  // Paid calls inside (search, images, …) are charged to this member and client.
  return opts.metering ? runWithMeteringScope(opts.metering, run) : run();
}

function formatZodError(error: unknown): string {
  const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> } | undefined)?.issues;
  if (!Array.isArray(issues)) return 'invalid input';
  return issues
    .map((i) => `${Array.isArray(i.path) ? i.path.join('.') : ''}: ${i.message ?? 'invalid'}`.trim())
    .join('; ');
}
