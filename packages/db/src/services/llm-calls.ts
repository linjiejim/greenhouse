/**
 * LLM Call service — audit log for one-shot `call_llm` sub-calls.
 *
 * Records the full prompt + output of tool-less LLM calls made from within a
 * session, so they can be retrospected later without being reloaded into the
 * calling session's context.
 */

import { randomUUID } from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { llmCalls } from '../schema/index.js';
import type { LlmCallRow } from '../schema/llm-call.js';

export interface LlmCallInput {
  session_id: string;
  user_id?: string | null;
  model: string;
  system?: string | null;
  input: string;
  output?: string | null;
  status?: 'ok' | 'error';
  error?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  duration_ms?: number | null;
}

export function createLlmCallService(db: Db) {
  return {
    /** Record one call_llm invocation. Returns the persisted row. */
    async record(input: LlmCallInput): Promise<LlmCallRow> {
      const row = {
        id: randomUUID(),
        session_id: input.session_id,
        user_id: input.user_id ?? null,
        model: input.model,
        system: input.system ?? null,
        input: input.input,
        output: input.output ?? null,
        status: input.status ?? 'ok',
        error: input.error ?? null,
        input_tokens: input.input_tokens ?? null,
        output_tokens: input.output_tokens ?? null,
        duration_ms: input.duration_ms ?? null,
        created_at: nowIso(),
      };
      const inserted = await db.insert(llmCalls).values(row).returning();
      return inserted[0] as LlmCallRow;
    },

    /** List the audited LLM calls for a session, newest first. */
    async listBySession(sessionId: string, limit = 100): Promise<LlmCallRow[]> {
      return (await db
        .select()
        .from(llmCalls)
        .where(eq(llmCalls.session_id, sessionId))
        .orderBy(desc(llmCalls.created_at))
        .limit(limit)) as LlmCallRow[];
    },
  };
}

export type LlmCallService = ReturnType<typeof createLlmCallService>;
