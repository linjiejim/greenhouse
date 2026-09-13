/**
 * Tool definition primitives — the neutral home for tool *metadata* shape and
 * the `defineTool` helper used to co-locate a tool's metadata with its
 * implementation in the same file.
 *
 * Design:
 * - Each tool file declares a local `meta` object and exports a module via
 *   `defineTool({ meta, create })`. The `description` lives right next to the
 *   `inputSchema`/`execute` it documents (reference it as `meta.description`).
 * - The catalog (`registry.ts`) imports every tool module explicitly and derives
 *   ALL aggregate views (metadata list, global ids, known-tool names)
 *   from that single array — no parallel hand-maintained id lists, no glob/
 *   side-effect self-registration that could silently drop a tool.
 *
 * This file imports NOTHING from individual tool files, so tool files can import
 * it freely without creating an import cycle.
 */

import type { DatabaseProvider } from '@greenhouse/db';
import type { RuntimeActionRisk } from '@greenhouse/types/runtime';
import type { McpResourceGroup } from '@greenhouse/types/mcp';

// ─── Metadata ────────────────────────────────────────────

export type ToolCategory = 'core' | 'team' | 'admin';

export interface ToolMeta {
  id: string; // code name, e.g. 'external_search'
  name: string; // display name, e.g. 'Web Search'
  brief: string; // one-liner for catalogs/admin UI (GET /api/tools, feature points) — never injected into prompts
  description: string; // full usage instructions — used as AI SDK tool({ description })
  category: ToolCategory;
  is_global: boolean; // true = default-on for internal users without assignment
  icon: string; // Lucide icon name
  /**
   * Whether/how this tool is reachable through the /api/agent proxy + /api/mcp server.
   * This is the SINGLE declarative source for the proxy/MCP exposure allowlists —
   * the registry derives READONLY_PROXY_ALLOWLIST / MUTATING_PROXY_ALLOWLIST /
   * MCP_EXPOSED_TOOL_IDS from these fields (no separate hand-maintained id lists).
   *
   * - proxy: 'read'  → READONLY proxy allowlist (read-only, no confirm gate).
   * - proxy: 'write' → MUTATING proxy allowlist (confirm-gated per call).
   * - proxy: 'none' / undefined → not reachable through the proxy at all.
   * - mcp: '<group>' → additionally exposed over /api/mcp, inside that resource
   *   group (must ALSO be proxied — a tool with a group but no proxy tier would
   *   be listed but never reachable). The group is what a user actually consents
   *   to: an OAuth grant carries `mcp:<group>` scopes and a token may only call
   *   tools in the groups it was granted. Declaring the group here rather than in
   *   a separate table means a new MCP tool cannot silently end up in no group at
   *   all — the union type forces an answer. See @greenhouse/types/mcp.
   * - workbench: true → safe to persist as a Home card and re-run whenever the
   *   owner opens or refreshes the workbench. This is deliberately narrower
   *   than proxy:'read': costly generation, arbitrary web searches, attachment
   *   analysis and other side-effectful or unbounded reads must stay false.
   * - unattendedReplaySafe: true → may run without a person present and may be
   *   repeated after a checkpointed Runtime lease expires. This is stricter
   *   than proxy:'read': paid provider calls and reads that create durable
   *   objects default to false even when they do not mutate business records.
   *
   * Default-deny: a tool with no `surface` is neither proxied nor MCP-exposed. This
   * is a security-relevant surface — see the guard test in
   * tools/__tests__/surface-derivation.test.ts which pins the derived sets.
   * (Feature-flag gating on top of this — e.g. CRM behind the `crm` flag on MCP —
   * stays in resolveMcpContext; surface declares reachability, not entitlement.)
   */
  surface?: {
    proxy?: 'read' | 'write' | 'none';
    mcp?: McpResourceGroup;
    workbench?: boolean;
    unattendedReplaySafe?: boolean;
  };
  /**
   * Part of every Agent's native ability, rather than something the author picks.
   *
   * A custom Agent's `tools` array is an intersection filter, so an author who
   * did not think to tick "scheduling" got an Agent that answers "I can't do
   * that" to a request any assistant is expected to handle — that is what a
   * broken Agent looks like, not a missing feature. These tools are unioned into
   * that filter so the author never has to know they exist.
   *
   * The bar: no independent permission, cost or outward-facing surface of its
   * own. Domain data (CRM, knowledge, Tables), paid providers and outbound
   * channels (email) stay opt-in, because "what may this Agent see and do" is
   * the author's design decision. `automation_mutation` is the one write here —
   * it is owner-scoped, quota-capped and already in UNATTENDED_TOOL_DENYLIST, so
   * it cannot self-propagate.
   *
   * NOTE: this only widens the profile filter, never the user's permissions —
   * the intersection with the caller's allow-set still applies, so a flag the
   * user does not have keeps the tool out. See resolveEffectiveTools.
   */
  builtin?: boolean;
  /**
   * Runtime ToolCall risk classification. Omit for ordinary reads (`r0`) and
   * proxy-confirmed writes (`surface.proxy='write'`, derived as `r2`). Set it
   * for catalog tools whose cost/reversible write risk is not represented by
   * the transport surface (for example memory or image generation).
   */
  runtime_risk?: RuntimeActionRisk;
  sort_order: number;
  /**
   * How this tool's result is surfaced in the chat UI:
   * - 'trace' (default) — a row inside the collapsible "N tool calls" block.
   * - 'artifact' — a rich card rendered inline in the message body.
   * The frontend artifact registry (apps/web/src/components/tool-call/body-artifacts.tsx)
   * is the authoritative render source; this flag declares the same intent at the
   * tool source (note: client-only tools like `update_page` have no ToolMeta, so the
   * FE registry — not this flag — is the complete list).
   */
  presentation?: 'trace' | 'artifact';
}

/**
 * How a tool is constructed, so the catalog can wire it without a separate
 * hand-maintained list:
 * - 'static'  — built once in the shared registry from just the db (or nothing).
 * - 'lazy'    — built per-request because it needs user context; wired in
 *               buildLazyServerTools / the chat route, not the static registry.
 * - 'special' — bespoke construction inside a route. No tool uses it today.
 */
export type ToolKind = 'static' | 'lazy' | 'special';

/** A `tool()` instance from the `ai` SDK. Kept loose to avoid leaking generics. */
export type AiTool = unknown;

export interface ToolModule {
  meta: ToolMeta;
  kind: ToolKind;
  /**
   * Factory for 'static' tools — receives the shared db. Omitted for lazy or
   * special tools whose construction needs request context and stays in its
   * existing call site (for example buildLazyServerTools or the chat route).
   */
  create?: (db: DatabaseProvider) => AiTool;
}

/** Identity helper — gives each tool module a precise type while co-locating meta. */
export function defineTool<T extends ToolModule>(mod: T): T {
  return mod;
}
