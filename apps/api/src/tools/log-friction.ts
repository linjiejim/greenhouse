/**
 * Log Friction tool — leave a note when the tooling got in your way.
 *
 * The daily miner already harvests hard tool errors out of message pipelines.
 * This tool covers what the miner cannot see: the detours that never errored —
 * three probes to find where a field lives, a parameter shape only discovered by
 * trial, a capability that simply is not there.
 *
 * Team-wide and write-only from the model's side: there is no read action, so a
 * model can neither browse nor mine what other people hit. A super reviews the
 * queue and fixes it in the harness.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { DatabaseProvider } from '@greenhouse/db';
import { defineTool, type ToolMeta } from './define.js';
import { recordFriction } from '../frictions/friction-center.js';
import { FRICTION_SUMMARY_MAX, FRICTION_DETAIL_MAX } from '../frictions/friction-limits.js';

const logFrictionSchema = z.object({
  kind: z
    .enum(['wrong_params', 'detour', 'data_quirk', 'capability_gap', 'tool_error'])
    .describe(
      'wrong_params: the call shape was not what the description implied. detour: it took several steps to find something that should be direct. data_quirk: the data itself is surprising (missing, renamed, in another unit). capability_gap: nothing available could do it. tool_error: a tool failed in a way worth flagging.',
    ),
  summary: z
    .string()
    .describe(
      `One line (≤${FRICTION_SUMMARY_MAX} chars) naming the specific obstacle, in English. "crm_query.get_customer needs type alongside id" — not "CRM was confusing".`,
    ),
  tool_id: z.string().optional().describe('The tool involved, if there is one (e.g. "crm_query").'),
  detail: z
    .string()
    .optional()
    .describe(
      `What you tried and what happened (≤${FRICTION_DETAIL_MAX} chars) — the call, the response, what finally worked. Quote identifiers and error text verbatim.`,
    ),
});

type LogFrictionInput = z.infer<typeof logFrictionSchema>;

export interface LogFrictionContext {
  sessionId?: string;
}

const meta: ToolMeta = {
  id: 'log_friction',
  name: 'Log Friction',
  brief: 'Leave a note when a tool or dataset made the work harder than it should be',
  description: `Leave a note for the people who maintain your tools when something got in your way: a call rejected although you followed its description, several probes to reach what should have been one call, data that behaved unexpectedly, or a capability that simply is not there. This improves the tooling — it is not a report about the user, is not shown to them, and is never replayed to you.

Log once per distinct obstacle, after you have worked around it, so you can say what actually worked. Skip ordinary empty results, a user changing their mind, and your own reasoning mistakes.

Write in English, but quote identifiers, field names, values and error strings EXACTLY as they appeared — those literals are the whole diagnostic value. Identical notes merge and count, so the count decides what gets fixed first: name the specific thing, not the feeling.`,
  category: 'core',
  is_global: true,
  builtin: true,
  icon: 'MessageSquareWarning',
  runtime_risk: 'r1',
  // No `surface` for now: a write into a team-wide table from a stateless
  // caller, with nothing for the per-call confirm gate to mean. Chat, scheduled
  // tasks and subagents can log; /api/agent and /api/mcp cannot (revisit if the
  // sandbox's frictions turn out to be the ones worth having).
  sort_order: 38,
};

export function createLogFrictionTool(db: DatabaseProvider, ctx: LogFrictionContext) {
  return tool({
    description: meta.description,
    inputSchema: logFrictionSchema,
    execute: async (input: LogFrictionInput) => {
      try {
        const result = await recordFriction(db, {
          tool_id: input.tool_id,
          kind: input.kind,
          summary: input.summary,
          detail: input.detail,
          session_id: ctx.sessionId,
        });
        if (!result.ok) return { error: result.error };

        return {
          logged: true,
          id: result.friction.id,
          occurrence_count: result.friction.occurrence_count,
          note:
            result.friction.occurrence_count > 1
              ? 'This obstacle has been logged before — the count was incremented.'
              : 'Logged for review.',
        };
      } catch (error) {
        return { error: toErrorMessage(error) };
      }
    },
  });
}

export const logFrictionTool = defineTool({ meta, kind: 'lazy' });
