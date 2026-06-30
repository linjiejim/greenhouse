/**
 * Agent runtime — cloud tool proxy.
 *
 * Exposes a curated subset of server tools to trusted runtimes (Local Agent,
 * CLI) via `/api/agent/*`.
 *
 * Two tiers:
 * - READ tools (READONLY_PROXY_ALLOWLIST): exposed for eligible internal users.
 * - WRITE tools (MUTATING_PROXY_ALLOWLIST): default-DENY unless the caller's
 *   auth scope includes them, and each call must pass `confirm: true`.
 *   Only unambiguously-mutating, bounded tools are listed here; mixed read/write
 *   tools (e.g. feature_request, project_manager) need per-action gating and are
 *   intentionally excluded for now. email_manager is instead exposed as split
 *   read/write tools (email_query/email_mutation) so each side lands cleanly in
 *   one tier.
 *
 * The proxy never widens permissions: the exposed set is always
 *   resolveEffectiveTools(user, profile) ∩ proxy allowlists.
 */

import { z } from 'zod';
import { logger } from '@greenhouse/utils/logger';
import type { ToolRegistry } from '../agent.js';
import { getToolMeta, READONLY_PROXY_ALLOWLIST, MUTATING_PROXY_ALLOWLIST } from '../tools/registry.js';

/**
 * The proxy read/write allowlists are DERIVED from each tool's declarative
 * `meta.surface` field in the tool catalog (apps/api/src/tools/registry.ts) — there
 * is no hand-maintained id list here. Default-deny: a tool with no `surface` is
 * never reachable via /api/agent. Re-exported so existing consumers
 * (api-auth.ts, mcp-auth.ts) keep importing them from this module.
 *
 * - READONLY_PROXY_ALLOWLIST: tools exposed read-only (no confirm gate).
 * - MUTATING_PROXY_ALLOWLIST: tools that are only reachable when the caller's
 *   write scope includes them AND the call passes `confirm: true`.
 */
export { READONLY_PROXY_ALLOWLIST, MUTATING_PROXY_ALLOWLIST };

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
  /** Extra READ narrowing; empty/undefined = no extra narrowing beyond proxy allowlist. */
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
  const readScope = opts.allowedTools && opts.allowedTools.length > 0 ? new Set(opts.allowedTools) : null;
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
 * - Non-empty allowlist → a *requested* workspace must be in it. Requests that
 *   carry no workspace pass: no workspace-bound tool is reachable through the
 *   read-only proxy yet, so there is nothing to scope. When such a tool is added
 *   to the allowlist, tighten this to require a workspace for scoped credentials.
 *
 * @throws ProxyToolError(403) when a workspace is requested but not permitted.
 */
export function assertWorkspaceAllowed(allowedWorkspaces: string[], workspaceId: string | null | undefined): void {
  if (allowedWorkspaces.length === 0) return;
  if (!workspaceId) return;
  if (!allowedWorkspaces.includes(workspaceId)) {
    throw new ProxyToolError(`Workspace "${workspaceId}" is not permitted for this credential`, 403);
  }
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
 */
export async function executeProxyTool(
  registry: ToolRegistry,
  toolId: string,
  allowedToolIds: string[],
  input: unknown,
  opts: { confirm?: boolean } = {},
): Promise<unknown> {
  const normalized = normalizeLegacyToolCall(toolId, input);
  const actualToolId = normalized.toolId;
  const actualInput = normalized.input;

  if (!allowedToolIds.includes(toolId) && !allowedToolIds.includes(actualToolId)) {
    throw new ProxyToolError(`Tool "${toolId}" is not available for this credential`, 403);
  }

  // Mutating tools require explicit per-call confirmation.
  if (isMutatingProxyTool(actualToolId) && opts.confirm !== true) {
    throw new ProxyToolError(`Tool "${actualToolId}" mutates state — pass confirm:true to execute`, 400);
  }

  const toolDef = registry[actualToolId] as
    | {
        inputSchema?: { safeParse?: (v: unknown) => { success: boolean; data?: unknown; error?: unknown } };
        execute?: (input: unknown, options: unknown) => Promise<unknown>;
      }
    | undefined;

  if (!toolDef || typeof toolDef.execute !== 'function') {
    throw new ProxyToolError(`Tool "${actualToolId}" has no executable implementation`, 404);
  }

  // Validate input against the tool's schema when it exposes a Zod-style safeParse.
  let validatedInput = actualInput;
  const schema = toolDef.inputSchema;
  if (schema && typeof schema.safeParse === 'function') {
    const result = schema.safeParse(actualInput ?? {});
    if (!result.success) {
      throw new ProxyToolError(`Invalid input for tool "${actualToolId}": ${formatZodError(result.error)}`, 400);
    }
    validatedInput = result.data;
  }

  return toolDef.execute(validatedInput, { toolCallId: `agent-proxy-${actualToolId}`, messages: [] });
}

function normalizeLegacyToolCall(toolId: string, input: unknown): { toolId: string; input: unknown } {
  const inputObj = typeof input === 'object' && input !== null && !Array.isArray(input) ? input : {};
  switch (toolId) {
    case 'search_team_knowledge':
    case 'search_greenhouse_doc':
      return { toolId: 'team_knowledge', input: { ...inputObj, action: 'search' } };
    case 'get_team_knowledge':
    case 'get_greenhouse_doc':
      return { toolId: 'team_knowledge', input: { ...inputObj, action: 'get' } };
    default:
      return { toolId, input };
  }
}

function formatZodError(error: unknown): string {
  const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> } | undefined)?.issues;
  if (!Array.isArray(issues)) return 'invalid input';
  return issues
    .map((i) => `${Array.isArray(i.path) ? i.path.join('.') : ''}: ${i.message ?? 'invalid'}`.trim())
    .join('; ');
}
