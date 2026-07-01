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
import { getGlobalToolIds, getPublicToolIds, getAllToolIds, STATIC_TOOL_MODULES } from './tools/registry.js';
import { getDb } from '@greenhouse/db';

// Re-export model factory from llm/ layer
export { createModelFromConfig, buildProviderOptions } from '@greenhouse/agent-core';

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
 * - external/anonymous: public-audience default-on tools only (getPublicToolIds)
 * - super: all tools
 * - member/admin: global_tools ∪ assigned_tools (from user_tools table)
 * All allowed tools are active — no user-side toggle.
 *
 * @param userId - null for external/anonymous users
 * @param userRole - 'super' | 'team' | 'external'
 */
export async function resolveUserTools(userId: string | null, userRole: string): Promise<ToolResolution> {
  const globalToolIds = getGlobalToolIds();

  // 1. Determine the full set of allowed tools
  let allowedTools: string[];

  if (!userId || userRole === 'external') {
    // External users: only public-audience default-on tools (NOT every is_global
    // tool — team/admin tools marked is_global stay internal-only, so they never
    // appear in an external user's allow-set or tool-aware system prompt).
    allowedTools = getPublicToolIds();
  } else if (userRole === 'super') {
    // Super: all tools
    allowedTools = getAllToolIds();
  } else {
    // team: global default-on tools + per-user assigned tools (no 'admin' role exists)
    const assignedTools = await getDb().userTools.getTools(userId);
    allowedTools = [...new Set([...globalToolIds, ...assignedTools])];
  }

  return { allowedTools, activeTools: allowedTools };
}

/**
 * Create all available tools (the full registry).
 * Tools are created once and shared — profiles select a subset.
 */
export function createToolRegistry(db: DatabaseProvider): ToolRegistry {
  const registry: ToolRegistry = {};

  // Static tools — built once from the shared db, derived from the catalog. Adding
  // a static tool is just exporting a `defineTool({ kind: 'static', create })`
  // module; no edit here. (Lazy/per-request tools — feature_request, knowledge_*,
  // etc. — are injected per-request in buildLazyServerTools/the chat route.)
  // Static tools read only ctx.db; the other context fields are placeholders.
  const staticCtx = { db, userId: 'system', userRole: 'super' };
  for (const mod of STATIC_TOOL_MODULES) {
    registry[mod.meta.id] = mod.create!(staticCtx);
  }

  // Whitelist every known tool name (static + lazy) for profile validation,
  // derived from the single catalog — no parallel hand-maintained list.
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
  userInfo?: string;
  relatedTopics?: string[];
}

/**
 * Build the full system prompt: static profile prompt + dynamic context.
 * Profile provides the static identity/instructions.
 * Context appends runtime information (user info, related topics, etc.)
 */
export function buildSystemPrompt(profile: AgentProfile, context?: AgentContext): string {
  const parts: string[] = [enrichSystemPrompt(profile)];

  if (context?.userInfo) {
    parts.push(`\n## User Context\n${context.userInfo}`);
  }

  if (context?.relatedTopics && context.relatedTopics.length > 0) {
    parts.push(`\n## Potentially Related Topics\n${context.relatedTopics.join(', ')}`);
  }

  return parts.join('\n');
}

// NOTE: There is intentionally no "tool-aware" prompt variant that lists tool
// names. Tool definitions (name, description, parameters) are already sent to
// the LLM via the `tools[]` function definitions in the API request, and any
// prompt-side list risks diverging from the actually-registered set (it once
// leaked internal tool names into public-profile sessions).
