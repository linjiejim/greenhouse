/**
 * Agent/Tool adapter for Projects actions.
 *
 * Tool implementations keep their transport-specific schemas and response
 * wording, while authorization, record scope, mutation, and platform audit all
 * pass through the same guarded application registry as HTTP.
 */

import type { AuthMethod, PlatformActionResult } from '@greenhouse/api/extension-kit';
import { delegatedAgentActor } from '@greenhouse/api/extension-kit';
import { projectResource, type ProjectActionId } from './application.js';
import { getPlatformRuntime } from '@greenhouse/api/extension-kit';

export interface ProjectAgentContext {
  userId: string;
  clientId?: string;
  authMethod?: AuthMethod;
}

export function dispatchProjectAgentAction(
  context: ProjectAgentContext,
  actionId: ProjectActionId,
  payload: unknown,
  ids: { projectId?: string | number; taskId?: string | number; commentId?: string | number } = {},
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
