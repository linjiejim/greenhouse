/**
 * Which MCP tools a member reaches — the per-request platform visibility rule
 * (`filterMcpToolIdsByPlatform`) and, for surfaces that describe the MCP server
 * to the member (the data catalog page), the tools a full grant would reach.
 *
 * Lives outside routes/mcp.ts so hub-context can ask the same question without
 * importing the route module; routes/mcp.ts re-exports it unchanged.
 */

import type { UserRole } from '@greenhouse/db';
import { resolveProfileAsync } from '../profiles/profile.js';
import type { AgentIdentity } from './api-auth.js';
import { resolveEffectiveTools } from './tool-resolution.js';
import { MUTATING_PROXY_ALLOWLIST, resolveProxyToolIds } from './tool-proxy.js';
import { MCP_EXPOSED_TOOL_IDS } from '../tools/registry.js';
import { delegatedAgentActor } from '../platform/actor.js';
import { getPlatformRuntime } from '../platform/runtime.js';
import { knowledgeManifest } from '../platform/manifests/knowledge.js';
import { extensionPlatformToolCapabilities } from '../extensions/boot.js';

/**
 * Profile used to resolve the bound user's tool set. Internal-only surface, so
 * MCP uses the canonical agent-runtime `desktop` profile (full internal tool
 * set), then narrows by the proxy allowlists and the MCP surface.
 */
export const MCP_PROFILE_ID = 'desktop';

function capabilitiesByActionKind(manifest: typeof knowledgeManifest, kind: 'query' | 'command'): string[] {
  return [
    ...new Set(
      Object.values(manifest.actions)
        .filter((action) => action.mcp && action.kind === kind)
        .map((action) => action.capability),
    ),
  ];
}

const PLATFORM_TOOL_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
  knowledge_query: capabilitiesByActionKind(knowledgeManifest, 'query'),
  knowledge_mutation: capabilitiesByActionKind(knowledgeManifest, 'command'),
  // Application-backed tools an extension owns follow the same rule.
  ...extensionPlatformToolCapabilities(capabilitiesByActionKind),
};

/**
 * Registry-migrated tools disappear when none of their actions are authorized.
 * Legacy tools remain governed by their existing feature/tool gates until their
 * M4 migration. This check is intentionally uncached so revocation affects the
 * very next tools/list request.
 */
export async function filterMcpToolIdsByPlatform(
  identity: Pick<AgentIdentity, 'userId'> & Partial<AgentIdentity>,
  toolIds: readonly string[],
): Promise<string[]> {
  const actor = delegatedAgentActor({ userId: identity.userId, authMethod: 'oauth' });
  const visibility = await Promise.all(
    toolIds.map(async (toolId) => {
      const capabilities = PLATFORM_TOOL_CAPABILITIES[toolId];
      if (!capabilities) return { toolId, visible: true };
      const decisions = await Promise.all(
        capabilities.map((capability) => getPlatformRuntime().authorize(actor, capability)),
      );
      return { toolId, visible: decisions.some((decision) => decision.allowed) };
    }),
  );
  return visibility.filter((entry) => entry.visible).map((entry) => entry.toolId);
}

/**
 * The MCP tools this member would reach with a grant of every resource group
 * and `mcp:write` — their own permissions, nothing more. What a real token
 * reaches is this set narrowed by its scopes (routes/mcp.ts composeMcpContext).
 */
export async function memberMcpToolIds(userId: string, userRole: Exclude<UserRole, 'external'>): Promise<Set<string>> {
  const profile = await resolveProfileAsync(MCP_PROFILE_ID);
  const { effectiveTools } = await resolveEffectiveTools({ userId, userRole, profile, profileId: MCP_PROFILE_ID });
  const ids = resolveProxyToolIds(effectiveTools, { allowedWriteTools: [...MUTATING_PROXY_ALLOWLIST] }).filter((id) =>
    MCP_EXPOSED_TOOL_IDS.has(id),
  );
  return new Set(await filterMcpToolIdsByPlatform({ userId }, ids));
}
