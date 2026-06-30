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
 *   ALL aggregate views (metadata list, global/public id sets, known-tool names)
 *   from that single array — no parallel hand-maintained id lists, no glob/
 *   side-effect self-registration that could silently drop a tool.
 *
 * This file imports NOTHING from individual tool files, so tool files can import
 * it freely without creating an import cycle.
 */

import type { DatabaseProvider } from '@greenhouse/db';

// ─── Metadata ────────────────────────────────────────────

export type ToolCategory = 'public' | 'team' | 'admin' | 'local';

export interface ToolMeta {
  id: string; // code name, e.g. 'external_search'
  name: string; // display name, e.g. 'Web Search'
  brief: string; // one-liner (always injected into prompt)
  description: string; // full usage instructions — used as AI SDK tool({ description })
  category: ToolCategory;
  is_global: boolean; // true = default-on for internal users without assignment
  icon: string; // Lucide icon name
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
  /**
   * Whether/how this tool is reachable through the /api/agent proxy + /api/mcp server.
   * This is the SINGLE declarative source for the proxy/MCP exposure allowlists —
   * the registry derives READONLY_PROXY_ALLOWLIST / MUTATING_PROXY_ALLOWLIST /
   * MCP_EXPOSED_TOOL_IDS from these fields (no separate hand-maintained id lists).
   *
   * - proxy: 'read'  → READONLY proxy allowlist (read-only, no confirm gate).
   * - proxy: 'write' → MUTATING proxy allowlist (confirm-gated per call).
   * - proxy: 'none' / undefined → not reachable through the proxy at all.
   * - mcp: true → additionally exposed over /api/mcp (must ALSO be proxied — a tool
   *   with mcp:true but no proxy tier would be listed but never reachable).
   *
   * Default-deny: a tool with no `surface` is neither proxied nor MCP-exposed. This
   * is a security-relevant surface — see the guard test in
   * tools/__tests__/surface-derivation.test.ts which pins the derived sets.
   */
  surface?: { proxy?: 'read' | 'write' | 'none'; mcp?: boolean };
}

/**
 * How a tool is constructed, so the catalog can wire it without a separate
 * hand-maintained list:
 * - 'static'  — built once in the shared registry from just the db (or nothing).
 * - 'lazy'    — built per-request because it needs user context; wired in
 *               buildLazyServerTools / the chat route, not the static registry.
 * - 'special' — bespoke construction outside the static registry.
 * - 'local'   — Desktop client-executed tool, built via createLocalTools().
 */
export type ToolKind = 'static' | 'lazy' | 'special' | 'local';

/** A `tool()` instance from the `ai` SDK. Kept loose to avoid leaking generics. */
export type AiTool = unknown;

export interface ToolModule {
  meta: ToolMeta;
  kind: ToolKind;
  /**
   * Factory for 'static' tools — receives the shared db. Omitted for lazy/
   * special/local tools, whose construction needs request context and stays in
   * its existing call site (buildLazyServerTools, chat route, createLocalTools).
   */
  create?: (db: DatabaseProvider) => AiTool;
}

/** Identity helper — gives each tool module a precise type while co-locating meta. */
export function defineTool<T extends ToolModule>(mod: T): T {
  return mod;
}
