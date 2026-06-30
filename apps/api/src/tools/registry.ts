/**
 * Tool Registry — the catalog that assembles all agent-tool metadata.
 *
 * Metadata for each single-purpose tool is CO-LOCATED with its implementation in
 * the tool's own file via `defineTool` (see ./define.ts). This file imports those
 * modules explicitly and derives every aggregate view (metadata list, global/
 * public id sets, known-tool names, the static tool factories) from one array —
 * no parallel hand-maintained id lists, no glob/side-effect self-registration.
 *
 * One tool group keeps CENTRAL metadata by design (see SPECIAL_METAS below):
 * local_* (homogeneous Desktop client tools resolved dynamically by id).
 *
 * Frontend fetches metadata via GET /api/tools.
 */

import type { ToolMeta, ToolCategory, ToolModule } from './define.js';
export type { ToolCategory, ToolMeta } from './define.js';

import { analyzeImageTool } from './analyze-image.js';
import { askUserTool } from './ask-user.js';
import { teamKnowledgeTool } from './team-knowledge.js';
import { personalKnowledgeTool } from './personal-knowledge.js';
import { externalSearchTool } from './external-search/index.js';
import { featureRequestTool } from './feature-request.js';
import { generateImageTool } from './generate-image.js';
import { projectManagerTool } from './project-manager.js';
import { projectQueryTool } from './project-query.js';
import { projectMutationTool } from './project-mutation.js';
import { computeTool } from './compute/tool.js';
import { emailManagerTool, emailQueryTool, emailMutationTool } from './email.js';
import { sessionHistoryTool } from './session-history.js';
import { sessionQueryTool } from './session-query.js';
import { spawnSessionTool } from './spawn-session.js';
import { callLlmTool } from './call-llm.js';
import { knowledgeQueryTool } from './knowledge-query.js';
import { knowledgeMutationTool } from './knowledge-mutation.js';

// ─── Catalog ─────────────────────────────────────────────

/** All single-purpose tools — metadata co-located in each file via defineTool. */
const TOOL_MODULES: ToolModule[] = [
  analyzeImageTool,
  askUserTool,
  teamKnowledgeTool,
  personalKnowledgeTool,
  externalSearchTool,
  featureRequestTool,
  generateImageTool,
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

/** Static tools (constructed once from the shared db) — drives createToolRegistry. */
export const STATIC_TOOL_MODULES: ToolModule[] = TOOL_MODULES.filter((m) => m.kind === 'static');

/**
 * Multi-variant / dynamically-keyed tools keep CENTRAL metadata by design:
 * - local_*: homogeneous Desktop client tools resolved dynamically by id.
 */
const SPECIAL_METAS: ToolMeta[] = [
  {
    id: 'local_file_read',
    name: 'Read File',
    brief: 'Read local file content',
    description: `Read a file from the local filesystem. Supports text files.
Path must be within the user's authorized directories.
Returns file content as text. Binary files return an error.
Use offset and limit for large files.`,
    category: 'local',
    is_global: false,
    icon: 'FileText',
    sort_order: 40,
  },
  {
    id: 'local_file_write',
    name: 'Write File',
    brief: 'Create or modify local files',
    description: `Write content to a local file. Creates parent directories if needed.
In 'ask' mode, requires user confirmation before writing.
In 'explore' mode, this tool is disabled.`,
    category: 'local',
    is_global: false,
    icon: 'FilePen',
    sort_order: 41,
  },
  {
    id: 'local_file_search',
    name: 'Search Files',
    brief: 'Search file contents with regex/glob patterns',
    description: `Search for text patterns in local files using grep-style matching.
Supports regex patterns, glob filters, and directory scoping.
Returns matching lines with file paths and line numbers.`,
    category: 'local',
    is_global: false,
    icon: 'SearchCode',
    sort_order: 42,
  },
  {
    id: 'local_shell',
    name: 'Shell',
    brief: 'Execute shell commands on the local machine',
    description: `Execute a shell command in the local terminal.
Dangerous commands are blocked (rm -rf /, sudo, etc.).
In 'ask' mode, displays the command and waits for user approval.
In 'explore' mode, only read-only commands are allowed (ls, cat, grep, find, git status, etc.).
Returns stdout, stderr, and exit code.`,
    category: 'local',
    is_global: false,
    icon: 'Terminal',
    sort_order: 43,
  },
  {
    id: 'local_clipboard',
    name: 'Clipboard',
    brief: 'Read from or write to system clipboard',
    description: `Access the system clipboard.
Actions: read (get current clipboard text), write (set clipboard text).`,
    category: 'local',
    is_global: false,
    icon: 'Clipboard',
    sort_order: 44,
  },
  {
    id: 'local_compute',
    name: 'Local Compute',
    brief: 'Execute code locally with full language support',
    description: `Execute code on the local machine with full access to installed runtimes.
Supported languages: javascript (node), python3, bash.
The code runs in a subprocess with access to local packages and tools.
Timeout: 30 seconds. Output captured from stdout/stderr.
Use this for data processing, script execution, and development tasks.`,
    category: 'local',
    is_global: false,
    icon: 'Code',
    sort_order: 45,
  },
  {
    id: 'local_skill_list',
    name: 'List Skills',
    brief: 'List local SKILL.md skills available on the Desktop client',
    description: `List local Agent Skills discovered by the Desktop client.
Returns only lightweight metadata such as slug, name, description, source, version, and glob hints.
Use this when you need to know which local skills are available before deciding whether to load one.
For full instructions, call local_skill_view with the skill slug.`,
    category: 'local',
    is_global: false,
    icon: 'Sparkles',
    sort_order: 46,
  },
  {
    id: 'local_skill_view',
    name: 'View Skill',
    brief: 'Load a local skill instruction file on demand',
    description: `Read a local SKILL.md file or a referenced supporting text file from a local skill directory.
Use this only when a listed skill is relevant to the user's current task.
Default path is SKILL.md. You may pass a relative path (for example references/guide.md) if the loaded skill instructs you to read it.
This tool is read-only and cannot execute scripts. Script execution remains governed by local_shell/local_compute permissions.`,
    category: 'local',
    is_global: false,
    icon: 'BookOpen',
    sort_order: 47,
  },
];

/** Single source of truth for all tool metadata. */
export const TOOL_DEFINITIONS: ToolMeta[] = [...TOOL_MODULES.map((m) => m.meta), ...SPECIAL_METAS];

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

/** Get all tool metadata, sorted by sort_order. */
export function getAllToolMetas(): ToolMeta[] {
  return [...TOOL_DEFINITIONS].sort((a, b) => a.sort_order - b.sort_order);
}
