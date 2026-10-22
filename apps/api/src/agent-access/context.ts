/**
 * Glue between the governed-write core and its two callers: the MCP route
 * (a live agent request) and the approval API (a member deciding later).
 */

import type { DatabaseProvider, RuntimeRunRow } from '@greenhouse/db';
import type { RuntimeActionRisk } from '@greenhouse/types/runtime';

import type { ToolRegistry } from '../agent.js';
import { identityFromOAuthScopes } from '../agent-runtime/mcp-auth.js';
import { getMcpResourceUrl, parseStoredOAuthScopes } from '../platform/oauth.js';
import { getWorkspaceValue } from '../settings/workspace-config.js';
import { getToolMeta } from '../tools/registry.js';
import type { AgentWriteRunInput, WriteCaller } from './governed-write.js';

export const LEGACY_CONFIRM_SETTING = 'agent_access.legacy_confirm';

/** Transition switch; unset means on (see the setting's registry entry). */
export async function legacyConfirmEnabled(): Promise<boolean> {
  const value = await getWorkspaceValue(LEGACY_CONFIRM_SETTING);
  return value === undefined || value === null ? true : value === true;
}

/** Catalog risk of a proxy write tool: its declared `runtime_risk`, else r2. */
export function baseWriteRisk(toolId: string): RuntimeActionRisk {
  return getToolMeta(toolId)?.runtime_risk ?? 'r2';
}

/**
 * Who the write belongs to and who decides. An interactive client acts for the
 * member who authorized it, and that member decides. A machine client
 * (client_credentials) is bound to a dedicated service user nobody signs in as,
 * so its creator decides — falling back to the bound user if the creator is
 * gone or no longer an admin.
 */
export async function resolveWriteCaller(
  db: DatabaseProvider,
  input: { userId: string; clientId: string; authMethod: 'oauth' | 'oauth-client' },
): Promise<WriteCaller> {
  const client = await db.platformOAuth.getClient(input.clientId);
  let approverUserId = input.userId;
  if (input.authMethod === 'oauth-client' && client?.created_by) {
    const creator = await db.users.getById(client.created_by);
    if (creator && creator.status === 'active' && creator.role === 'super') approverUserId = creator.id;
  }
  return {
    userId: input.userId,
    clientId: input.clientId,
    clientName: client?.client_name ?? input.clientId,
    authMethod: input.authMethod,
    approverUserId,
  };
}

/**
 * What the agent may do at the moment an approved write runs, re-derived from
 * the CURRENT client, grant and user. A revoked client, a narrowed scope or a
 * disabled member stops the write even though it was approved.
 */
export async function resolveApprovedWriteContext(
  db: DatabaseProvider,
  toolRegistry: ToolRegistry,
  run: RuntimeRunRow,
  input: AgentWriteRunInput,
): Promise<{ ok: true; registry: ToolRegistry; toolIds: string[] } | { ok: false; reason: string }> {
  const client = await db.platformOAuth.getClient(input.client_id);
  if (!client || client.status !== 'active') return { ok: false, reason: 'The agent has been disabled or removed' };
  const grant = await db.platformOAuth.getGrantByPrincipal(run.owner_user_id, client.id, getMcpResourceUrl());
  if (!grant || grant.status !== 'active') return { ok: false, reason: "The agent's access has been revoked" };
  let scopes;
  try {
    scopes = parseStoredOAuthScopes(grant.scopes);
  } catch {
    return { ok: false, reason: "The agent's grant has invalid scopes" };
  }
  if (!scopes.includes('mcp:write')) return { ok: false, reason: 'The agent no longer has write access' };
  const user = await db.users.getById(run.owner_user_id);
  if (!user || user.status !== 'active' || (user.role !== 'team' && user.role !== 'super')) {
    return { ok: false, reason: 'The member is no longer active' };
  }
  const identity = identityFromOAuthScopes({ id: user.id, role: user.role }, scopes);
  // routes/mcp.ts owns tool-context composition; imported lazily because it
  // imports this module for the live write path.
  const { composeMcpContext } = await import('../routes/mcp.js');
  const ctx = await composeMcpContext(identity, toolRegistry);
  if (!ctx.toolIds.includes(input.tool_id))
    return { ok: false, reason: 'This tool is no longer available to the agent' };
  return { ok: true, registry: ctx.registry, toolIds: ctx.toolIds };
}
