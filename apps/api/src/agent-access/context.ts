/**
 * Glue between the MCP route and the recorded-write core.
 */

import type { DatabaseProvider } from '@greenhouse/db';
import type { RuntimeActionRisk } from '@greenhouse/types/runtime';

import { getToolMeta } from '../tools/registry.js';
import type { WriteCaller } from './governed-write.js';

/** Catalog risk of a proxy write tool: its declared `runtime_risk`, else r2. */
export function baseWriteRisk(toolId: string): RuntimeActionRisk {
  return getToolMeta(toolId)?.runtime_risk ?? 'r2';
}

/** The tool declares that every call only adds (`meta.mcp_additive`). */
export function declaredAdditive(toolId: string): boolean {
  return getToolMeta(toolId)?.mcp_additive === true;
}

/** Who a write belongs to (the member the credential is bound to) and which agent made it. */
export async function resolveWriteCaller(
  db: DatabaseProvider,
  input: { userId: string; clientId: string; authMethod: 'oauth' | 'oauth-client' },
): Promise<WriteCaller> {
  const client = await db.platformOAuth.getClient(input.clientId);
  return {
    userId: input.userId,
    clientId: input.clientId,
    clientName: client?.client_name ?? input.clientId,
    authMethod: input.authMethod,
  };
}
