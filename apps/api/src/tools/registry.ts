/**
 * Tool Registry — the catalog that assembles all agent-tool metadata.
 *
 * Metadata for each single-purpose tool is CO-LOCATED with its implementation in
 * the tool's own file via `defineTool` (see ./define.ts). This file imports those
 * modules explicitly and derives every aggregate view (metadata list, global
 * ids, known-tool names, the static tool factories) from one array —
 * no parallel hand-maintained id lists, no glob/side-effect self-registration.
 *
 * SPECIAL_METAS is currently empty: no tool is constructed inside a route any
 * more. The hook stays for the next one.
 *
 * Frontend fetches metadata via GET /api/tools.
 */

import { fromExtensions } from '../extensions/index.js';
import type { ToolMeta, ToolModule } from './define.js';
export type { ToolCategory, ToolMeta } from './define.js';

import { analyzeImageTool } from './analyze-image.js';
import { askUserTool } from './ask-user.js';
import { externalSearchTool } from './external-search/index.js';
import { generateImageTool } from './generate-image.js';
import { computeTool } from './compute/tool.js';
import { sessionQueryTool } from './session-query.js';
import { taskCaptureTool } from './task-capture.js';
import { readAttachmentTool } from './read-attachment.js';
import { callLlmTool } from './call-llm.js';
import { knowledgeQueryTool } from './knowledge-query.js';
import { knowledgeMutationTool } from './knowledge-mutation.js';
import { tablesQueryTool } from './tables-query.js';
import { tablesMutationTool } from './tables-mutation.js';
import { tablesSchemaPlanTool } from './tables-schema-plan.js';
import { exportDataTool } from './export-data.js';
import { automationQueryTool } from './automation-query.js';
import { automationMutationTool } from './automation-mutation.js';
import { mcpCallTool } from './mcp-call.js';
import { filesQueryTool } from './files-query.js';
import { filesMutationTool } from './files-mutation.js';
import { readUrlTool, webSearchTool } from './web-search.js';

// ─── Catalog ─────────────────────────────────────────────

/** All single-purpose tools — metadata co-located in each file via defineTool. */
const CORE_TOOL_MODULES: ToolModule[] = [
  analyzeImageTool,
  askUserTool,
  externalSearchTool,
  generateImageTool,
  computeTool,
  sessionQueryTool,
  taskCaptureTool,
  readAttachmentTool,
  callLlmTool,
  knowledgeQueryTool,
  knowledgeMutationTool,
  tablesQueryTool,
  tablesMutationTool,
  tablesSchemaPlanTool,
  exportDataTool,
  automationQueryTool,
  automationMutationTool,
  mcpCallTool,
  filesQueryTool,
  filesMutationTool,
  webSearchTool,
  readUrlTool,
];

/** Static tools (constructed once from the shared db) — drives createToolRegistry. */
/** Ids of the tools this repository ships, without any extension's — what the surface guard pins. */
export const CORE_TOOL_IDS: ReadonlySet<string> = new Set(CORE_TOOL_MODULES.map((m) => m.meta.id));

/** Core tools followed by the tools of every active extension (see extensions/index.ts). */
const TOOL_MODULES: ToolModule[] = withExtensionTools(CORE_TOOL_MODULES, fromExtensions('tools'));

function withExtensionTools(core: ToolModule[], extension: ToolModule[]): ToolModule[] {
  const ids = new Set(core.map((m) => m.meta.id));
  for (const mod of extension) {
    if (ids.has(mod.meta.id)) throw new Error(`Extension tool "${mod.meta.id}" collides with an existing tool id`);
    ids.add(mod.meta.id);
  }
  return [...core, ...extension];
}

export const STATIC_TOOL_MODULES: ToolModule[] = TOOL_MODULES.filter((m) => m.kind === 'static');

/** Route-constructed tools keep CENTRAL metadata here rather than in TOOL_MODULES. */
const SPECIAL_METAS: ToolMeta[] = [];

/** Single source of truth for all tool metadata. */
export const TOOL_DEFINITIONS: ToolMeta[] = [...TOOL_MODULES.map((m) => m.meta), ...SPECIAL_METAS];

/**
 * Retired tool ids → their successors. Custom profiles persist tool id arrays in
 * the DB, so a retirement must keep old rows meaningful: resolveEffectiveTools
 * expands these before intersecting. (Proxy-side call aliases for once-exposed
 * ids live in tool-proxy's normalizeLegacyToolCall — input shapes differ there.)
 *
 * Optional modules contribute their aliases only while enabled, like their tools.
 */
const retiredAliases: Record<string, readonly string[]> = {
  session_history: ['session_query'],
  team_knowledge: ['knowledge_query'],
  personal_knowledge: ['knowledge_query'],
};
for (const aliases of fromExtensions('retiredToolAliases')) {
  for (const [retired, successors] of Object.entries(aliases)) {
    if (retired in retiredAliases || TOOL_DEFINITIONS.some((tool) => tool.id === retired))
      throw new Error(`Retired tool alias "${retired}" collides with an existing tool or alias`);
    if (!successors.length || successors.some((id) => !TOOL_DEFINITIONS.some((tool) => tool.id === id)))
      throw new Error(`Retired tool alias "${retired}" must name live successor tools`);
    retiredAliases[retired] = successors;
  }
}
export const RETIRED_TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = retiredAliases;

// ─── Derived exposure sets (single source: each tool's `meta.surface`) ──────
//
// The proxy/MCP allowlists and the lazy-tool set are DERIVED from the catalog —
// there is no hand-maintained id list to keep in sync. Writing a new tool file
// with `surface` set auto-exposes it on /api/agent (+ /api/mcp with mcp:true);
// a tool with no `surface` is default-denied from both. Security-relevant:
// tools/__tests__/surface-derivation.test.ts pins the exact derived sets so an
// accidental exposure change fails CI.

/** Read-only tools reachable via the /api/agent proxy (no confirm gate). */
export const READONLY_PROXY_ALLOWLIST = new Set<string>(
  TOOL_DEFINITIONS.filter((m) => m.surface?.proxy === 'read').map((m) => m.id),
);

/** Mutating tools the proxy may expose — confirm-gated per call, default-DENY. */
export const MUTATING_PROXY_ALLOWLIST = new Set<string>(
  TOOL_DEFINITIONS.filter((m) => m.surface?.proxy === 'write').map((m) => m.id),
);

/** Tools additionally exposed over /api/mcp (all are also proxy-reachable). */
export const MCP_EXPOSED_TOOL_IDS = new Set<string>(TOOL_DEFINITIONS.filter((m) => m.surface?.mcp).map((m) => m.id));

/**
 * MCP resource group → the tools inside it. This is what an OAuth grant actually
 * authorizes: a token carries `mcp:<group>` scopes, and mcp-auth narrows the
 * caller's tools to the union of the granted groups (see @greenhouse/types/mcp).
 *
 * Derived, like every other exposure set, from each tool's own `meta.surface` —
 * a tool cannot be MCP-exposed without naming its group, so there is no way to
 * land in "exposed but ungrouped".
 */
export const MCP_TOOL_IDS_BY_GROUP: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const meta of TOOL_DEFINITIONS) {
    const group = meta.surface?.mcp;
    if (!group) continue;
    const bucket = map.get(group) ?? new Set<string>();
    bucket.add(meta.id);
    map.set(group, bucket);
  }
  return map;
})();

/**
 * Retired resource groups → exactly the tools a grant carrying them reached
 * before the group was retired (RETIRED_MCP_RESOURCE_GROUP_IDS in
 * @greenhouse/types/mcp). A stored `mcp:image` keeps `generate_image` and
 * gains nothing from the group that tool moved into.
 */
export const LEGACY_MCP_GROUP_TOOLS: Readonly<Record<string, readonly string[]>> = {
  image: ['generate_image'],
};

/** Tool ids reachable for a set of granted resource groups. Unknown groups are ignored. */
export function mcpToolIdsForGroups(groups: Iterable<string>): Set<string> {
  const ids = new Set<string>();
  for (const group of groups) {
    for (const id of MCP_TOOL_IDS_BY_GROUP.get(group) ?? LEGACY_MCP_GROUP_TOOLS[group] ?? []) ids.add(id);
  }
  return ids;
}

/**
 * Tools every Agent has, whether or not its author ticked them.
 *
 * A custom Agent's declared `tools` is an intersection filter, so anything the
 * author did not think of is simply absent — and an Agent that cannot ask a
 * clarifying question, read the file you just attached or schedule the thing
 * you asked it to schedule reads as broken rather than as narrow. These are
 * unioned into that filter, never into the user's permissions.
 */
export const BUILTIN_AGENT_TOOL_IDS = new Set<string>(
  TOOL_DEFINITIONS.filter((m) => m.builtin === true).map((m) => m.id),
);

/**
 * Per-request (lazy/special) tool ids — need request context, absent from the
 * static registry. Derived from each module's `kind` + the special metas.
 */
export const LAZY_TOOL_IDS = new Set<string>([
  ...TOOL_MODULES.filter((m) => m.kind !== 'static').map((m) => m.meta.id),
  ...SPECIAL_METAS.map((m) => m.id),
]);

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

/** Get all tool IDs. */
export function getAllToolIds(): string[] {
  return TOOL_DEFINITIONS.map((t) => t.id);
}

/** Get all tool metadata, sorted by sort_order. */
export function getAllToolMetas(): ToolMeta[] {
  return [...TOOL_DEFINITIONS].sort((a, b) => a.sort_order - b.sort_order);
}

/** Tools only members' agents get, over MCP and the Agent API (`surface.externalOnly`). */
export const EXTERNAL_ONLY_TOOL_IDS: ReadonlySet<string> = new Set(
  TOOL_DEFINITIONS.filter((m) => m.surface?.externalOnly === true).map((m) => m.id),
);

/** Whether the in-app surfaces (Chat, its tool picker, permissions, the Agent editor) may show this tool. */
export function isInAppTool(id: string): boolean {
  return !EXTERNAL_ONLY_TOOL_IDS.has(id);
}

/** Tool metadata for the in-app catalogs, sorted by sort_order. */
export function getInAppToolMetas(): ToolMeta[] {
  return getAllToolMetas().filter((m) => isInAppTool(m.id));
}

/** Tool ids an in-app Agent or a per-user assignment may name. */
export function getInAppToolIds(): string[] {
  return getAllToolIds().filter(isInAppTool);
}
