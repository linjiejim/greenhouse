/**
 * Chat eval service — per-message faithfulness & hallucination evaluation results (PostgreSQL).
 */

import { desc, eq } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { chatEvalResults } from '../schema/index.js';
import type { ChatEvalResultRow } from '../schema/chat-eval.js';

export interface ChatEvalResultInput {
  message_id: string;
  session_id: string;
  question: string;
  answer: string;
  /** Weighted 0–10; null when verdict is 'pending'. */
  score_final: number | null;
  verdict: string;
  /** JSON strings (see schema column docs). */
  classification: string;
  dimensions: string;
  consistency_detail: string;
  citation_issues: string;
  suggestions: string;
  judge_reasoning: string;
  references_checked: string;
  duration_ms: number;
  input_tokens?: number | null;
  output_tokens?: number | null;
  eval_session_id?: string | null;
}

export function createChatEvalService(db: Db) {
  const service = {
    /**
     * Save an evaluation result. `message_id` is UNIQUE, so a re-eval UPSERTS —
     * the row (incl. eval_session_id and created_at) is replaced with the latest
     * run rather than throwing a duplicate-key error.
     */
    async save(input: ChatEvalResultInput): Promise<ChatEvalResultRow> {
      const values = {
        message_id: input.message_id,
        session_id: input.session_id,
        question: input.question,
        answer: input.answer,
        score_final: input.score_final,
        verdict: input.verdict,
        classification: input.classification,
        dimensions: input.dimensions,
        consistency_detail: input.consistency_detail,
        citation_issues: input.citation_issues,
        suggestions: input.suggestions,
        judge_reasoning: input.judge_reasoning,
        references_checked: input.references_checked,
        duration_ms: input.duration_ms,
        input_tokens: input.input_tokens ?? null,
        output_tokens: input.output_tokens ?? null,
        eval_session_id: input.eval_session_id ?? null,
        created_at: nowIso(),
      };
      const [saved] = await db
        .insert(chatEvalResults)
        .values(values)
        .onConflictDoUpdate({ target: chatEvalResults.message_id, set: values })
        .returning();
      return saved;
    },

    /** Get cached result by message ID — most recent run wins (re-evals insert new rows). */
    async getByMessageId(messageId: string): Promise<ChatEvalResultRow | null> {
      const rows = await db
        .select()
        .from(chatEvalResults)
        .where(eq(chatEvalResults.message_id, messageId))
        .orderBy(desc(chatEvalResults.created_at))
        .limit(1);
      return rows[0] ?? null;
    },

    /** List results for a session. */
    async getBySessionId(sessionId: string): Promise<ChatEvalResultRow[]> {
      return await db.select().from(chatEvalResults).where(eq(chatEvalResults.session_id, sessionId));
    },
  };
  return service;
}

export type ChatEvalService = ReturnType<typeof createChatEvalService>;
