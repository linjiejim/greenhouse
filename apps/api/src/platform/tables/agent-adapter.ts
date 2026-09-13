/**
 * Agent/Proxy/MCP adapter for Tables actions.
 */

import type { AuthMethod, PlatformActionResult } from '@greenhouse/platform-kernel';
import { delegatedAgentActor } from '../actor.js';
import { getPlatformRuntime } from '../runtime.js';
import { tablesResource, type TablesActionId } from './application.js';

export interface TablesAgentContext {
  userId: string;
  clientId?: string;
  authMethod?: AuthMethod;
}

export function dispatchTablesAgentAction(
  context: TablesAgentContext,
  actionId: TablesActionId,
  payload: unknown,
  ids: Parameters<typeof tablesResource>[1] = {},
): Promise<PlatformActionResult> {
  return getPlatformRuntime().dispatch({
    actor: delegatedAgentActor({
      userId: context.userId,
      clientId: context.clientId,
      authMethod: context.authMethod,
    }),
    appId: 'tables',
    actionId,
    payload,
    resource: tablesResource(actionId, ids),
  });
}
