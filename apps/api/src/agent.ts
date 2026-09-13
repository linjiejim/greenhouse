/**
 * Agent configuration — model factory, tool registry, prompt builder.
 *
 * Refactored to work with AgentProfile definitions.
 * Supports multiple LLM providers via lazy dynamic imports.
 */

import type { DatabaseProvider } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import type { AgentProfile } from './profile.js';
import { enrichSystemPrompt, registerKnownTools } from './profile.js';
import { getGlobalToolIds, getAllToolIds, STATIC_TOOL_MODULES } from './tools/registry.js';
import { FEATURE_POINTS, WORKFLOWS_SUPER_ONLY_TOOL_IDS } from './platform/feature-points.js';
import { resolveUserFeatures } from './auth/features.js';
import { getDb } from '@greenhouse/db';

// ─── Tool Registry ───────────────────────────────────────

export type ToolRegistry = Record<string, any>;

// ─── Tool Resolution ─────────────────────────────────────

export interface ToolResolution {
  /** All tools the user is allowed to use (registered to LLM). */
  allowedTools: string[];
  /** Alias for allowedTools — all allowed tools are active. */
  activeTools: string[];
}

/**
 * Resolve the effective tool set for a user.
 *
 * - super: all tools
 * - team: global_tools ∪ assigned_tools (from user_tools table) ∪ the tools owned by
 *   each enabled feature flag (derived from FEATURE_POINTS) — so one feature toggle
 *   governs its chat/proxy/MCP tools too, not a separate per-user tool assignment.
 *   This is the ONLY place flags gate tools; downstream surfaces must not re-gate.
 * - missing/non-internal identity: no tools (fail closed)
 * All allowed tools are active — no user-side toggle.
 *
 * @param userId - authenticated internal user ID
 * @param userRole - current database role
 */
export async function resolveUserTools(userId: string, userRole: string): Promise<ToolResolution> {
  const globalToolIds = getGlobalToolIds();

  // 1. Determine the full set of allowed tools
  let allowedTools: string[];

  if (userRole === 'super') {
    // Super: all tools
    allowedTools = getAllToolIds();
  } else if (userRole === 'team') {
    // team: global default-on tools + per-user assigned tools (no 'admin' role exists)
    // + the tools owned by each enabled feature flag, derived from FEATURE_POINTS
    // so the flag→tool map has exactly one home.
    //
    // Flags MUST come from the resolver (one query, defaultEnabled-aware) — the
    // raw userFeatures.isEnabled table read returns false for default-ON flags
    // that have no row, which is how memory v1 shipped dead.
    const [assignedTools, features] = await Promise.all([
      getDb().userTools.getTools(userId),
      resolveUserFeatures(userId, 'team'),
    ]);
    const flagOwnedTools = FEATURE_POINTS.flatMap((point) => (point.flag && features[point.flag] ? point.toolIds : []));
    const superOnlyTools = new Set(WORKFLOWS_SUPER_ONLY_TOOL_IDS);
    // Workflow is temporarily in a super-only rollout. Filter explicit legacy
    // assignments too, so an old user_tools row cannot bypass the role gate.
    allowedTools = [...new Set([...globalToolIds, ...assignedTools, ...flagOwnedTools])].filter(
      (toolId) => !superOnlyTools.has(toolId),
    );
  } else {
    allowedTools = [];
  }

  return { allowedTools, activeTools: allowedTools };
}

/**
 * Create all available tools (the full registry).
 * Tools are created once and shared — profiles select a subset.
 *
 * Note: per-user tools (knowledge_*, project_*, memory, …) are NOT in the global
 * registry — they are built per-request (see the lazy tools in
 * agent-runtime/tool-resolution.ts) once the caller is resolved.
 */
export function createToolRegistry(db: DatabaseProvider): ToolRegistry {
  const registry: ToolRegistry = {};

  // Static tools — built once from the shared db, derived from the catalog. Adding
  // a static tool is just exporting a `defineTool({ kind: 'static', create })`
  // module; no edit here. (Lazy/per-request tools — feature_request, knowledge_*,
  // etc. — are injected per-request in buildLazyServerTools/chat route.)
  for (const mod of STATIC_TOOL_MODULES) {
    registry[mod.meta.id] = mod.create!(db);
  }

  // Whitelist every known tool name (static + lazy + special) for profile
  // validation, derived from the single catalog — no parallel hand-maintained list.
  registerKnownTools(getAllToolIds());

  return registry;
}

/**
 * Select a subset of tools from the registry based on profile configuration.
 */
export function selectTools(registry: ToolRegistry, toolNames: string[]): ToolRegistry {
  const selected: ToolRegistry = {};
  for (const name of toolNames) {
    if (registry[name]) {
      selected[name] = registry[name];
    } else {
      logger.warn(`[Agent] ⚠️ Tool "${name}" not found in registry, skipping`);
    }
  }
  return selected;
}

// ─── System Prompt ───────────────────────────────────────

export interface AgentContext {
  /** Server-assembled user context (notes + memories) — never client-supplied. */
  userInfo?: string;
}

/**
 * Build the full system prompt: static profile prompt + dynamic context.
 * Profile provides the static identity/instructions; context appends the
 * server-assembled user info block.
 */
export function buildSystemPrompt(profile: AgentProfile, context?: AgentContext): string {
  const parts: string[] = [enrichSystemPrompt(profile)];

  if (context?.userInfo) {
    parts.push(`\n## User Context\n${context.userInfo}`);
  }

  return parts.join('\n');
}

// NOTE: There is intentionally no "tool-aware" prompt variant that lists tool
// names. Tool definitions (name, description, parameters) are already sent to
// the LLM via the `tools[]` function definitions in the API request, and any
// prompt-side list risks diverging from the actually-registered set (it once
// leaked tool names into profile-narrowed sessions).
