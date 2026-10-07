/**
 * `self` — a Bot proposing a change to its own standing instructions.
 *
 * OpenClaw's rule "if you change SOUL.md, tell the user" made explicit: the
 * proposal becomes an `instructions_update` card the member accepts or
 * declines (requests.ts). Nothing is written until they do — a Bot that read a
 * poisoned page must not be able to rewrite its own rules. A tainted turn may
 * still propose: the proposal itself has no effect.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { BotInstructionsUpdatePayload } from '@greenhouse/types/bots';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { BotTurnContext } from '../engine/context.js';
import { validateBotInstructions } from '../engine/naming.js';

/** A proposal waits a week: it is a durable suggestion, not an in-flight step. */
export const INSTRUCTIONS_PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REASON_MAX = 300;

const selfSchema = z.object({
  action: z.literal('propose_instructions'),
  instructions: z.string().describe('The complete new standing instructions (the whole text, not a diff).'),
  reason: z.string().describe('Why, in one or two sentences — shown to the member on the card.'),
});

export function createSelfTool(ctx: BotTurnContext) {
  return tool({
    description:
      'Propose a change to your own standing instructions (propose_instructions {instructions, reason}). The member sees a card and decides; nothing changes until they accept.',
    inputSchema: selfSchema,
    execute: async (input) => {
      try {
        const instructions = validateBotInstructions(input.instructions);
        if (!instructions.ok) return { action: input.action, status: 'refused', reason: instructions.error };
        const reason = input.reason.replace(/\s+/g, ' ').trim();
        if (!reason) return { action: input.action, status: 'refused', reason: 'reason is required' };
        if (instructions.instructions === ctx.bot.instructions.trim()) {
          return {
            action: input.action,
            status: 'refused',
            reason: 'The proposed instructions are identical to the current ones',
          };
        }
        const payload: BotInstructionsUpdatePayload = {
          instructions: instructions.instructions,
          reason: reason.slice(0, REASON_MAX),
          current: ctx.bot.instructions,
        };
        const request = await ctx.createRequest('instructions_update', payload, {
          expiresInMs: INSTRUCTIONS_PROPOSAL_TTL_MS,
        });
        return {
          action: input.action,
          status: 'proposed',
          request_id: request.id,
          note: 'The member now sees a card with your proposed instructions and the reason. Nothing changes until they accept it — say in one line what you proposed, then carry on with the task.',
        };
      } catch (error) {
        return { action: input.action, error: toErrorMessage(error) };
      }
    },
  });
}
