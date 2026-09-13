/**
 * MCP resource groups — the granularity at which a user authorizes an MCP client.
 *
 * SINGLE SOURCE OF TRUTH for how the `/api/mcp` tool surface is carved up for
 * consent. Consumed by:
 *   • apps/api — each tool declares its group in `meta.surface.mcp`
 *                (apps/api/src/tools/define.ts); the OAuth layer derives one
 *                `mcp:<group>` scope per entry (apps/api/src/platform/oauth.ts)
 *   • apps/web — the consent screen's checklist (pages/oauth-consent.tsx) and
 *                the machine-client form (pages/settings/mcp-keys.tsx)
 *
 * This module carries IDENTITY ONLY — no display copy. Every user-visible label
 * lives in the locale files under `mcpGroups.<id>`, derived via
 * `apps/web/src/lib/mcp-groups.ts`; a hardcoded English label here would reach
 * the consent screen untranslated.
 *
 * ─── How an authorization resolves ───────────────────────
 * Resource groups are ORTHOGONAL to `mcp:read` / `mcp:write`: the former say
 * *which data*, the latter *which verbs*. The tools a token may call are
 *
 *     (tools in the granted groups) ∩ (read tools ∪ write tools if mcp:write)
 *
 * and then, per request, ∩ the bound user's own permissions. Granting a group
 * never widens what that user could already do.
 *
 * ─── Adding a group ──────────────────────────────────────
 * Add an entry here, then set `surface: { …, mcp: '<id>' }` on the tools that
 * belong to it. The scope, the consent checkbox and the admin picker all follow
 * automatically. Note that existing grants do NOT gain the new group — a user
 * authorized a set of capabilities that did not include it, so picking it up
 * silently would be exactly the widening this design exists to prevent.
 */

/**
 * The groups, in the order the consent screen lists them. Identity only —
 * display copy comes from `mcpGroups.<id>.{label,description}` in the locales.
 */
export const MCP_RESOURCE_GROUP_IDS = [
  'knowledge',
  'projects',
  'tables',
  'skills',
  'chat',
  'automation',
  'image',
] as const;

export type McpResourceGroup = (typeof MCP_RESOURCE_GROUP_IDS)[number];

export function isMcpResourceGroup(value: string): value is McpResourceGroup {
  return (MCP_RESOURCE_GROUP_IDS as readonly string[]).includes(value);
}
