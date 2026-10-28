/**
 * Which MCP tools a member reaches — the per-request platform visibility rule
 * (`filterMcpToolIdsByPlatform`).
 *
 * Lives outside routes/mcp.ts so hub-context can ask the same question without
 * importing the route module; routes/mcp.ts re-exports it unchanged.
 */

import type { AgentIdentity } from './api-auth.js';
import { delegatedAgentActor } from '../plugin-host/actor.js';
import { getPlatformRuntime } from '../plugin-host/runtime.js';
import { extensionPlatformToolCapabilities } from '../plugin-host/boot.js';

/**
 * Profile used to resolve the bound user's tool set. Internal-only surface, so
 * MCP uses the canonical agent-runtime `desktop` profile (full internal tool
 * set), then narrows by the proxy allowlists and the MCP surface.
 */
export const MCP_PROFILE_ID = 'desktop';

function capabilitiesByActionKind(
  manifest: import('@greenhouse/platform-kernel').ApplicationManifest,
  kind: 'query' | 'command',
): string[] {
  return [
    ...new Set(
      Object.values(manifest.actions)
        .filter((action) => action.mcp && action.kind === kind)
        .map((action) => action.capability),
    ),
  ];
}

const PLATFORM_TOOL_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
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
