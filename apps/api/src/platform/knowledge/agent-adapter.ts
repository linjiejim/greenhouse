/**
 * Agent/MCP adapter for guarded Knowledge tool calls.
 */

import type { PlatformActionResult } from '@greenhouse/platform-kernel';
import { delegatedAgentActor } from '../actor.js';
import { dispatchKnowledgeOperation, type KnowledgeActionId } from './adapter.js';

export interface KnowledgeAgentContext {
  userId: string;
  clientId?: string;
}

export async function runKnowledgeAgentAction<T>(
  context: KnowledgeAgentContext,
  actionId: KnowledgeActionId,
  payload: unknown,
  operation: () => PromiseLike<T> | T,
  documentId?: number | string,
): Promise<T | { error: string }> {
  const result = await dispatchKnowledgeOperation(
    delegatedAgentActor({
      userId: context.userId,
      clientId: context.clientId,
    }),
    actionId,
    payload,
    async (): Promise<PlatformActionResult<T>> => {
      try {
        return { ok: true, data: await operation() };
      } catch {
        return {
          ok: false,
          code: 'INTERNAL_ERROR',
          message: 'Knowledge operation failed',
        };
      }
    },
    { documentId },
  );
  return result.ok ? (result.data as T) : { error: result.message };
}
