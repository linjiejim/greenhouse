/**
 * Knowledge transport adapter for the guarded platform registry.
 */

import type { ActorContext, PlatformActionResult } from '@greenhouse/platform-kernel';
import { knowledgeManifest } from '../manifests/knowledge.js';
import { getPlatformRuntime } from '../runtime.js';

export type KnowledgeActionId = keyof typeof knowledgeManifest.actions;

export function knowledgeResource(
  actionId: KnowledgeActionId,
  ids: { documentId?: number | string; version?: number } = {},
) {
  const action = knowledgeManifest.actions[actionId];
  return {
    appId: knowledgeManifest.id,
    moduleId: action.module,
    entityId: action.entity,
    recordId: ids.documentId === undefined ? undefined : String(ids.documentId),
  };
}

export function dispatchKnowledgeOperation<T>(
  actor: ActorContext,
  actionId: KnowledgeActionId,
  payload: unknown,
  operation: () => Promise<PlatformActionResult<T>>,
  ids: { documentId?: number | string; version?: number } = {},
): Promise<PlatformActionResult<T>> {
  return getPlatformRuntime().dispatch(
    {
      actor,
      appId: knowledgeManifest.id,
      actionId,
      payload,
      resource: knowledgeResource(actionId, ids),
    },
    operation,
  ) as Promise<PlatformActionResult<T>>;
}
