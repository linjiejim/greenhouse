/**
 * Agent/Tool adapter for Projects actions.
 *
 * Tool implementations keep their transport-specific schemas and response
 * wording, while authorization, record scope, mutation, and platform audit all
 * pass through the same guarded application registry as HTTP.
 */

import type { AuthMethod, PlatformActionResult } from '@greenhouse/platform-kernel';
import { delegatedAgentActor } from '../actor.js';
import { projectResource, type ProjectActionId } from './application.js';
import { getPlatformRuntime } from '../runtime.js';

export interface ProjectAgentContext {
  userId: string;
  clientId?: string;
  authMethod?: AuthMethod;
}

export function dispatchProjectAgentAction(
  context: ProjectAgentContext,
  actionId: ProjectActionId,
  payload: unknown,
  ids: { projectId?: number; taskId?: number; commentId?: number } = {},
): Promise<PlatformActionResult> {
  return getPlatformRuntime().dispatch({
    actor: delegatedAgentActor({
      userId: context.userId,
      clientId: context.clientId,
      authMethod: context.authMethod,
    }),
    appId: 'projects',
    actionId,
    payload,
    resource: projectResource(actionId, ids),
  });
}
