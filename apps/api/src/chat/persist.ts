/**
 * Chat result persistence — host-side companion to the @greenhouse/agent-core engine.
 *
 * Persists assistant message and DSML recovery metadata after a
 * stream finishes (including the disconnected-client background-save path).
 * Used by /api/chat. Lives in the api (not the kernel) so the engine stays
 * database-free. LLM attempt usage is already durably recorded at the concrete
 * provider boundary before the terminal stream part reaches this module.
 */

import { getDb } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import type { ChatEngineResult, DsmlRecoveryEvent } from '@greenhouse/agent-core';

// ─── Persist ─────────────────────────────────────────────

export interface PersistInput {
  sessionId: string;
  /** Logical caller label (currently `chat`). */
  caller: string;
  modelId: string;
  engineResult: ChatEngineResult;
  dsmlRecoveries: DsmlRecoveryEvent[];
  streamCompleted: boolean;
  interruptionReason?: string;
  interruptionNotice: string;
  /** Exact assistant tail to atomically replace after a successful regeneration. */
  replaceAssistantMessageId?: string;
  /** Exact transcript revision that must still be the tail for a normal reply. */
  expectedTail?: {
    id: string;
    content: string;
  };
  /** Stable Runtime-derived identity closes transcript→Runtime crash windows. */
  resultMessageId?: string;
}

function incompleteRichBlockStart(content: string): number | null {
  const openFence = /```(?:chart|confirm|datatable)[^\S\r\n]*\r?\n/g;
  let match: RegExpExecArray | null;

  while ((match = openFence.exec(content)) !== null) {
    const closingFence = content.indexOf('```', openFence.lastIndex);
    if (closingFence === -1) return match.index;
    openFence.lastIndex = closingFence + 3;
  }

  return null;
}

/** Make an interrupted partial answer safe to render and durable after reload. */
export function finalizeInterruptedChatContent(content: string, notice: string): string {
  const incompleteAt = incompleteRichBlockStart(content);
  const safeContent = (incompleteAt == null ? content : content.slice(0, incompleteAt)).trimEnd();
  const noticeBlock = `> ${notice}`;
  return safeContent ? `${safeContent}\n\n${noticeBlock}` : noticeBlock;
}

/**
 * Persist chat result to DB: assistant message, LLM usage, DSML recovery metadata.
 * Called by /api/chat after the stream completes.
 */
export async function persistChatResult(input: PersistInput): Promise<void> {
  const {
    sessionId,
    caller,
    modelId,
    engineResult,
    dsmlRecoveries,
    streamCompleted,
    interruptionReason,
    interruptionNotice,
    replaceAssistantMessageId,
    expectedTail,
    resultMessageId,
  } = input;
  const hasIncompleteRichBlock = incompleteRichBlockStart(engineResult.text) != null;
  const content =
    interruptionReason || hasIncompleteRichBlock
      ? finalizeInterruptedChatContent(engineResult.text, interruptionNotice)
      : engineResult.text;

  if (content && replaceAssistantMessageId && streamCompleted && !interruptionReason) {
    const replacement = await getDb().sessions.replaceLatestAssistant(
      sessionId,
      replaceAssistantMessageId,
      {
        session_id: sessionId,
        role: 'assistant',
        content,
        references: engineResult.references,
        pipeline: engineResult.pipelineSteps,
        reasoning: engineResult.reasoningText,
        model: modelId,
        input_tokens: engineResult.usage.inputTokens || undefined,
        output_tokens: engineResult.usage.outputTokens || undefined,
        cached_tokens: engineResult.usage.cachedInputTokens || undefined,
        reasoning_tokens: engineResult.usage.reasoningTokens || undefined,
        duration_ms: engineResult.durationMs,
      },
      resultMessageId,
    );
    if (!replacement.ok) {
      logger.warn(`[${caller}] skipped stale assistant replacement`, {
        sessionId,
        assistantMessageId: replaceAssistantMessageId,
        reason: replacement.reason,
      });
    }
  } else if (content && !replaceAssistantMessageId) {
    if (!streamCompleted && !interruptionReason) {
      logger.info(`[${caller}] background save: client disconnected, persisting from SDK promises`);
    }
    if (hasIncompleteRichBlock && !interruptionReason) {
      logger.warn(`[${caller}] normalized an unfinished rich-output block before persistence`, { sessionId });
    }
    const assistantMessage = {
      session_id: sessionId,
      role: 'assistant' as const,
      content,
      references: engineResult.references,
      pipeline: engineResult.pipelineSteps,
      reasoning: engineResult.reasoningText,
      model: modelId,
      input_tokens: engineResult.usage.inputTokens || undefined,
      output_tokens: engineResult.usage.outputTokens || undefined,
      cached_tokens: engineResult.usage.cachedInputTokens || undefined,
      reasoning_tokens: engineResult.usage.reasoningTokens || undefined,
      duration_ms: engineResult.durationMs,
    };
    if (expectedTail) {
      const appended = await getDb().sessions.appendAssistantIfTail(
        sessionId,
        expectedTail,
        assistantMessage,
        resultMessageId,
      );
      if (!appended.ok) {
        logger.warn(`[${caller}] skipped assistant persistence after transcript changed`, {
          sessionId,
          expectedTailMessageId: expectedTail.id,
          reason: appended.reason,
        });
      }
    } else {
      // Stateless callers do not reach this persistence path. Keep the fallback
      // for internal/legacy callers that intentionally have no transcript CAS.
      await getDb().sessions.addMessage(assistantMessage);
    }
  }

  // Record DSML recoveries in session metadata
  if (dsmlRecoveries.length > 0) {
    try {
      const sess = await getDb().sessions.getById(sessionId);
      const meta = JSON.parse(sess?.metadata || '{}');
      meta.dsml_recoveries = (meta.dsml_recoveries || 0) + dsmlRecoveries.length;
      meta.last_dsml_at = dsmlRecoveries[dsmlRecoveries.length - 1].timestamp;
      await getDb().sessions.update(sessionId, { metadata: JSON.stringify(meta) });
    } catch {
      /* ignore */
    }
  }
}
