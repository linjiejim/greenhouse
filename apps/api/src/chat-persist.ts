/**
 * Chat result persistence — host-side companion to the @greenhouse/agent-core engine.
 *
 * Persists the assistant message and LLM usage after a stream finishes
 * (including the disconnected-client background-save path). Shared by /api/chat
 * and /api/v1/chat/completions. Lives in the api (not the kernel) so the engine
 * stays database-free.
 */

import { getDb } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import type { ChatEngineResult } from '@greenhouse/agent-core';

// ─── Persist ─────────────────────────────────────────────

export interface PersistInput {
  sessionId: string;
  profileId: string;
  /** 'chat' for internal, 'api-v1' for external */
  caller: string;
  /** userId for internal, appId for external */
  userId: string;
  modelId: string;
  engineResult: ChatEngineResult;
  streamCompleted: boolean;
}

/**
 * Persist chat result to DB: assistant message + LLM usage.
 * Shared by both /api/chat and /api/v1/chat/completions.
 */
export async function persistChatResult(input: PersistInput): Promise<void> {
  const { sessionId, profileId, caller, userId, modelId, engineResult, streamCompleted } = input;

  if (engineResult.text) {
    if (!streamCompleted) {
      logger.info(`[${caller}] background save: client disconnected, persisting from SDK promises`);
    }
    await getDb().sessions.addMessage({
      session_id: sessionId,
      role: 'assistant',
      content: engineResult.text,
      references: engineResult.references,
      pipeline: engineResult.pipelineSteps,
      reasoning: engineResult.reasoningText,
      input_tokens: engineResult.usage.inputTokens || undefined,
      output_tokens: engineResult.usage.outputTokens || undefined,
      cached_tokens: engineResult.usage.cachedInputTokens || undefined,
      reasoning_tokens: engineResult.usage.reasoningTokens || undefined,
      duration_ms: engineResult.durationMs,
    });
  }

  // Record LLM usage
  if (engineResult.usage.inputTokens || engineResult.usage.outputTokens) {
    getDb()
      .usage.record({
        profile_id: profileId,
        caller,
        session_id: sessionId,
        user_id: userId,
        model: modelId,
        input_tokens: engineResult.usage.inputTokens,
        output_tokens: engineResult.usage.outputTokens,
        cached_tokens: engineResult.usage.cachedInputTokens ?? 0,
        reasoning_tokens: engineResult.usage.reasoningTokens ?? 0,
        duration_ms: engineResult.durationMs,
      })
      .catch(() => {});
  }
}
