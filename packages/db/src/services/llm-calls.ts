/**
 * LLM Call service — audit record for one-shot `call_llm` sub-calls.
 *
 * Records the full prompt + output of tool-less LLM calls made from within a
 * session, so they can be retrospected later without being reloaded into the
 * calling session's context. Stored as a `usage_events` row of kind `audit`:
 * it carries no units and no cost (the call's spend is metered separately), so
 * it never adds to usage totals.
 */

import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { newId } from '../ids.js';
import { usageEvents } from '../schema/index.js';

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

const LLM_CALL_SERVICE = 'call_llm';

export function createLlmCallService(db: Db) {
  return {
    /** Record one call_llm invocation. Returns the id of the audit row. */
    async record(input: LlmCallInput): Promise<{ id: string }> {
      const id = newId('usageEvent');
      await db.insert(usageEvents).values({
        id,
        kind: 'audit',
        service: LLM_CALL_SERVICE,
        caller: LLM_CALL_SERVICE,
        model: input.model,
        units: 0,
        cost_usd_micros: null,
        user_id: input.user_id ?? null,
        session_id: input.session_id,
        duration_ms: input.duration_ms ?? null,
        detail: {
          system: input.system ?? null,
          input: input.input,
          output: input.output ?? null,
          status: input.status ?? 'ok',
          error: input.error ?? null,
          input_tokens: input.input_tokens ?? null,
          output_tokens: input.output_tokens ?? null,
        },
        created_at: nowIso(),
      });
      return { id };
    },
  };
}

export type LlmCallService = ReturnType<typeof createLlmCallService>;
