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
import type { AgentProfile } from '../profile.js';

// ─── Metadata ────────────────────────────────────────────

/**
 * Audience/permission axis: WHO may hold a tool. Aligned with `users.role`:
 * - 'public' → everyone, including external/anonymous callers (v1/chat).
 * - 'team'   → internal users (super + team).
 * - 'super'  → super-admins only. Never default-on, never user-assignable, never
 *   proxy/MCP-exposed; gated by role at resolution AND at execution.
 * (Distinct from profile-manifest `level` — that's per-profile visibility, not
 * per-tool audience — and from `users.role`, an identity, not an audience.)
 */
export type ToolCategory = 'public' | 'team' | 'super';

/**
 * Functional domain a tool belongs to — the axis the UI groups by. This is
 * ORTHOGONAL to `category` (an audience/permission axis: who may hold the tool).
 * `category` answers "who", `group` answers "what it does". Drives the section
 * grouping in the profile editor and the ordering from `getAllToolMetas`.
 */
export type ToolGroup =
  | 'knowledge'
  | 'projects'
  | 'email'
  | 'sessions'
  | 'web'
  | 'media'
  | 'compute'
  | 'interaction'
  | 'admin';

/**
 * Display order + human labels for the functional groups — the SINGLE source of
 * truth for how tools are sectioned and ordered. `getAllToolMetas` sorts by this
 * order (then alphabetically by name within a group). Replaces the old
 * hand-tuned per-tool `sort_order`: to reorder sections, reorder this array.
 */
export const TOOL_GROUPS: readonly { id: ToolGroup; label: string }[] = [
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'projects', label: 'Projects & Tasks' },
  { id: 'email', label: 'Email' },
  { id: 'sessions', label: 'Sessions & Delegation' },
  { id: 'web', label: 'Web & Search' },
  { id: 'media', label: 'Media' },
  { id: 'compute', label: 'Compute' },
  { id: 'interaction', label: 'Interaction' },
  { id: 'admin', label: 'Admin & Analytics' },
];

export interface ToolMeta {
  id: string; // code name, e.g. 'external_search'
  name: string; // display name, e.g. 'Web Search'
  brief: string; // one-liner (always injected into prompt)
  description: string; // full usage instructions — used as AI SDK tool({ description })
  category: ToolCategory;
  is_global: boolean; // true = default-on for internal users without assignment
  icon: string; // Lucide icon name
  group: ToolGroup; // functional domain — the axis the UI groups/orders by
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
 * - 'static' — built ONCE in the shared registry; needs nothing per-request
 *   (only `db`, available at startup). No `requires`.
 * - 'lazy'   — built PER-REQUEST because it needs request context (the calling
 *   user / the session / …). Declares that context via `requires`; the generic
 *   builder (`buildLazyServerTools`) constructs it — no hand-maintained wiring.
 */
export type ToolKind = 'static' | 'lazy';

/** A `tool()` instance from the `ai` SDK. Kept loose to avoid leaking generics. */
export type AiTool = unknown;

/** A built tool set, keyed by tool id. Structural — avoids importing agent.ts. */
export type ToolRegistryShape = Record<string, unknown>;

/**
 * Everything a tool's `create` may receive. Static tools read only `ctx.db`;
 * lazy tools additionally read the request-scoped fields they declared in
 * `requires`. `userId` is ALWAYS a string — 'anonymous' when there is no
 * authenticated user (only `user: 'optional'` tools are built in that case).
 *
 * The raw tool registry is deliberately NOT exposed here; the one tool that
 * needs to assemble a child tool set (spawn_session) gets the narrow
 * `assembleChildTools` closure instead, so a tool can never reach the full set.
 */
export interface ToolContext {
  db: DatabaseProvider;
  userId: string;
  userRole: string;
  sessionId?: string;
  profileId?: string | null;
  workspaceId?: string | null;
  /**
   * Builds a child session's tool set (only for spawn_session). Provided by the
   * lazy builder when a tool declares `requires.registry`, so this file needn't
   * import the resolution layer.
   */
  assembleChildTools?: (args: {
    childSessionId: string;
    profile: AgentProfile;
    depth: number;
  }) => Promise<ToolRegistryShape> | ToolRegistryShape;
}

/**
 * What request context a 'lazy' tool needs. The generic builder enforces these
 * BEFORE constructing the tool — the SAME guards the old hand-written if-ladder
 * applied, now declared next to the tool:
 * - user: 'optional' → built even for anonymous (userId defaults to 'anonymous').
 * - user: 'required' → needs an authenticated userId.
 * - user: 'internal' → needs an authenticated, non-external userId.
 * - user: 'super'    → needs role === 'super' (super-admin-only tools). The build
 *   guard is one of TWO gates — the tool's `execute` must re-check the role too
 *   (defense in depth), since a stale/forged context must never expose it.
 * - session: true    → needs a sessionId (session-scoped tools).
 * - registry: true   → needs the shared registry (gets `assembleChildTools`).
 */
export interface ToolRequirements {
  user?: 'optional' | 'required' | 'internal' | 'super';
  session?: boolean;
  registry?: boolean;
}

export interface ToolModule {
  meta: ToolMeta;
  kind: ToolKind;
  /**
   * Builds the tool from context. Static tools read only `ctx.db`; lazy tools
   * read the request-scoped fields they declared in `requires`. Both kinds set
   * this — a lazy module sets it together with `requires`.
   */
  create?: (ctx: ToolContext) => AiTool;
  /** Present on 'lazy' tools — the request context they need (see ToolRequirements). */
  requires?: ToolRequirements;
}

/**
 * Identity helper — co-locates a tool's metadata with its construction. Typed as
 * `ToolModule` (not generic) so the `create` callback's `ctx` is contextually
 * typed as `ToolContext` in every tool file without a per-file type import.
 */
export function defineTool(mod: ToolModule): ToolModule {
  return mod;
}
