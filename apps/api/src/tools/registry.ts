/**
 * Tool Registry — the catalog that assembles all agent-tool metadata.
 *
 * Metadata for each single-purpose tool is CO-LOCATED with its implementation in
 * the tool's own file via `defineTool` (see ./define.ts). This file imports those
 * modules explicitly and derives every aggregate view (metadata list, global/
 * public id sets, known-tool names, the static tool factories) from one array —
 * no parallel hand-maintained id lists, no glob/side-effect self-registration.
 *
 * Frontend fetches metadata via GET /api/tools.
 */

import type { ToolMeta, ToolCategory, ToolModule } from './define.js';
import { TOOL_GROUPS } from './define.js';
export type { ToolCategory, ToolMeta, ToolGroup } from './define.js';
export { TOOL_GROUPS } from './define.js';

import { analyzeImageTool } from './media/analyze-image.js';
import { askUserTool } from './interaction/ask-user.js';
import { externalSearchTool } from './external-search/index.js';
import { featureRequestTool } from './interaction/feature-request.js';
import { generateImageTool } from './media/generate-image.js';
import { projectManagerTool } from './projects/project-manager.js';
import { projectQueryTool } from './projects/project-query.js';
import { projectMutationTool } from './projects/project-mutation.js';
import { computeTool } from './compute/tool.js';
import { exportTableTool } from './files/export-table.js';
import { emailManagerTool, emailQueryTool, emailMutationTool } from './email/index.js';
import { sessionHistoryTool } from './sessions/session-history.js';
import { sessionQueryTool } from './sessions/session-query.js';
import { spawnSessionTool } from './sessions/spawn-session.js';
import { callLlmTool } from './sessions/call-llm.js';
import { knowledgeQueryTool } from './knowledge/knowledge-query.js';
import { knowledgeMutationTool } from './knowledge/knowledge-mutation.js';
import { EXTENSION_TOOL_MODULES } from './extensions.js';

// ─── Catalog ─────────────────────────────────────────────

/** Core single-purpose tools — metadata co-located in each file via defineTool. */
const CORE_TOOL_MODULES: ToolModule[] = [
  analyzeImageTool,
  askUserTool,
  externalSearchTool,
  featureRequestTool,
  generateImageTool,
  exportTableTool,
  projectManagerTool,
  projectQueryTool,
  projectMutationTool,
  computeTool,
  emailManagerTool,
  emailQueryTool,
  emailMutationTool,
  sessionHistoryTool,
  sessionQueryTool,
  spawnSessionTool,
  callLlmTool,
  knowledgeQueryTool,
  knowledgeMutationTool,
];

/**
 * The full module list every aggregate view is derived from: core tools plus any
 * private tools a downstream fork contributes via ./extensions.ts (empty
 * upstream). Splicing the fork's modules in HERE means the derived metadata,
 * global/public sets and the proxy/MCP allowlists all include them automatically
 * — the fork never edits this file. See tools/extensions.ts.
 */
const TOOL_MODULES: ToolModule[] = [...CORE_TOOL_MODULES, ...EXTENSION_TOOL_MODULES];

/** Static tools (constructed once from the shared db) — drives createToolRegistry. */
export const STATIC_TOOL_MODULES: ToolModule[] = TOOL_MODULES.filter((m) => m.kind === 'static');

/**
 * Lazy tools (built per-request from context) — drives buildLazyServerTools and
 * the derived LAZY_TOOL_IDS set. Replaces the old hand-maintained id list.
 */
export const LAZY_TOOL_MODULES: ToolModule[] = TOOL_MODULES.filter((m) => m.kind === 'lazy');

/** Single source of truth for all tool metadata. */
export const TOOL_DEFINITIONS: ToolMeta[] = TOOL_MODULES.map((m) => m.meta);

// ─── Proxy / MCP exposure (derived from each tool's declarative `meta.surface`) ──
//
// These three sets are the SINGLE source of truth for what `/api/agent` (the tool
// proxy) and `/api/mcp` (the MCP server) may expose. They are DERIVED from each
// tool's `meta.surface` field — there is no hand-maintained id list to keep in
// sync. Writing a new tool file with `surface` set auto-exposes it; a tool with no
// `surface` is default-denied from both surfaces. This is a security-relevant
// surface; see tools/__tests__/surface-derivation.test.ts which pins the exact
// derived sets so any future mistake fails CI.

/** Tools reachable read-only through the `/api/agent` proxy (no confirm gate). */
export const READONLY_PROXY_ALLOWLIST = new Set<string>(
  TOOL_DEFINITIONS.filter((m) => m.surface?.proxy === 'read').map((m) => m.id),
);

/** Tools reachable as confirm-gated writes through the `/api/agent` proxy. */
export const MUTATING_PROXY_ALLOWLIST = new Set<string>(
  TOOL_DEFINITIONS.filter((m) => m.surface?.proxy === 'write').map((m) => m.id),
);

/**
 * Tools additionally exposed over `/api/mcp`. A tool must ALSO be in one of the
 * proxy allowlists above to be reachable (mcp:true alone never grants access).
 */
export const MCP_EXPOSED_TOOL_IDS = new Set<string>(TOOL_DEFINITIONS.filter((m) => m.surface?.mcp).map((m) => m.id));

// ─── Lookup Helpers ──────────────────────────────────────

const toolMetaMap = new Map(TOOL_DEFINITIONS.map((t) => [t.id, t]));

/** Get tool description for use in AI SDK tool({ description }). Single source of truth. */
export function getToolDescription(id: string): string {
  const meta = toolMetaMap.get(id);
  if (!meta) throw new Error(`Unknown tool ID: ${id}`);
  return meta.description;
}

/** Get metadata for a single tool by ID. */
export function getToolMeta(id: string): ToolMeta | undefined {
  return toolMetaMap.get(id);
}

/** Get all global tool IDs (default-on for internal users without assignment). */
export function getGlobalToolIds(): string[] {
  return TOOL_DEFINITIONS.filter((t) => t.is_global).map((t) => t.id);
}

/**
 * Get the tool IDs external/anonymous users may use.
 *
 * Audience and default-on are orthogonal: `category` decides WHO may hold a tool,
 * `is_global` decides default-on vs. explicit assignment. External users get only
 * tools that are BOTH default-on AND public-audience — so a `team`/`admin` tool
 * marked `is_global` (default-on for internal users) never leaks to external
 * users' allow-set or their tool-aware system prompt.
 */
export function getPublicToolIds(): string[] {
  return TOOL_DEFINITIONS.filter((t) => t.is_global && t.category === 'public').map((t) => t.id);
}

/** Get tools by category. */
export function getToolsByCategory(category: ToolCategory): ToolMeta[] {
  return TOOL_DEFINITIONS.filter((t) => t.category === category);
}

/** Get all tool IDs. */
export function getAllToolIds(): string[] {
  return TOOL_DEFINITIONS.map((t) => t.id);
}

/** Rank of each functional group for display ordering (its index in TOOL_GROUPS). */
const GROUP_RANK = new Map(TOOL_GROUPS.map((g, i) => [g.id, i]));

/**
 * Get all tool metadata, ordered by functional group (TOOL_GROUPS order) then
 * alphabetically by name within a group. Replaces the old sort_order ordering —
 * to change section order, reorder TOOL_GROUPS in define.ts.
 */
export function getAllToolMetas(): ToolMeta[] {
  return [...TOOL_DEFINITIONS].sort((a, b) => {
    const ra = GROUP_RANK.get(a.group) ?? Number.MAX_SAFE_INTEGER;
    const rb = GROUP_RANK.get(b.group) ?? Number.MAX_SAFE_INTEGER;
    return ra - rb || a.name.localeCompare(b.name);
  });
}
