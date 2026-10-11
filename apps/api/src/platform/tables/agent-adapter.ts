/**
 * Agent/Proxy/MCP adapter for Tables actions.
 */

import type { AuthMethod, PlatformActionResult } from '@greenhouse/platform-kernel';
import { delegatedAgentActor, humanActor } from '../actor.js';
import { getPlatformRuntime } from '../runtime.js';
import type { TablesActionId } from '../manifests/tables.js';
import { tablesResource, type TablesResourceIds } from './audit.js';

export interface TablesAgentContext {
  userId: string;
  clientId?: string;
  authMethod?: AuthMethod;
}

/**
 * A member's own decision carried out away from an HTTP request — the
 * "Apply" on a Bots card (`bots/engine/requests.ts`): the member acts, as a
 * person, exactly as the chat card's apply route dispatches for them.
 */
export function dispatchTablesMemberAction(
  userId: string,
  actionId: TablesActionId,
  payload: unknown,
  ids: TablesResourceIds = {},
): Promise<PlatformActionResult> {
  return getPlatformRuntime().dispatch({
    actor: humanActor({ id: userId }),
    appId: 'tables',
    actionId,
    payload,
    resource: tablesResource(actionId, ids),
  });
}

export function dispatchTablesAgentAction(
  context: TablesAgentContext,
  actionId: TablesActionId,
  payload: unknown,
  ids: TablesResourceIds = {},
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
