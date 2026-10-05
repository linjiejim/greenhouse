/**
 * `team` — work with the member's other Bots in this conversation (spec §5).
 *
 * - list: who is here, and who else the member has;
 * - ask: hand a piece of work to a member Bot. The floor controller decides
 *   (cycle / repeat / depth / budget refusals come back as a reason, not an
 *   error); an accepted ask writes a visible hand-off line, queues the target
 *   to answer next and ends the asker's turn after this step;
 * - add: invite one of the member's existing Bots;
 * - create: PROPOSE a new Bot — a confirmation card; the Bot only exists after
 *   the member confirms it with their own credentials (a model can never
 *   persist a new identity with standing instructions on its own).
 *
 * Built per turn by the Bots engine only (`special` in the catalog).
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import { IMPLICIT_POOL, hashSeed, plantAvatarConfig } from '@greenhouse/types';
import { BOT_INSTRUCTIONS_MAX, BOT_NAME_MAX, BOT_ROLE_MAX } from '@greenhouse/types/bots';
import type { BotCreatePayload } from '@greenhouse/types/bots';
import type { BotTurnContext } from '../engine/context.js';
import type { AskRejection } from '../engine/floor.js';
import type { TeamPort } from '../engine/ports.js';
import { validateBotInstructions, validateBotName, validateBotRole } from '../engine/naming.js';
import { BOT_TOOL_METAS } from './meta.js';

const DESCRIPTION = BOT_TOOL_METAS.find((meta) => meta.id === 'team')?.description ?? 'team';

const teamSchema = z.object({
  action: z.enum(['list', 'ask', 'add', 'create']).describe('list | ask | add | create'),
  bot_id: z.string().max(64).optional().describe('ask / add: the Bot id (or exact name) from list.'),
  message: z
    .string()
    .max(6000)
    .optional()
    .describe('ask: a precise, self-contained brief — what you need, the context it needs, the form of the answer.'),
  name: z.string().max(BOT_NAME_MAX).optional().describe('create: the new Bot’s name.'),
  role: z.string().max(BOT_ROLE_MAX).optional().describe('create: its job title, a few words.'),
  instructions: z
    .string()
    .max(BOT_INSTRUCTIONS_MAX)
    .optional()
    .describe('create: how it should work (its standing instructions).'),
});
type TeamInput = z.infer<typeof teamSchema>;

const REFUSAL: Record<AskRejection, string> = {
  bot_chat_off:
    'The member switched off Bot-to-Bot hand-offs in this conversation. Do the work yourself or tell the member who could help.',
  self: 'You cannot hand work to yourself.',
  not_member: 'That Bot is not in this conversation. Use list; invite it with add first if the member has it.',
  cycle:
    'That Bot is already waiting on this hand-off chain — handing back would loop. Finish the part you can and answer.',
  repeat: 'That Bot was already asked in this round. Do not ask it again; use what it said.',
  queued:
    'That Bot was also addressed by the member and answers after you anyway. Do not hand it work; answer your part and leave the rest to it.',
  asks: 'This round already used its hand-offs. Finish with what you have.',
  depth: 'Hand-offs cannot go deeper in this round. Do this part yourself.',
  turns: 'Not enough turns left in this round for another hand-off. Finish with what you have.',
  budget:
    'This round hit its collaboration limit — no more hand-offs. Finish with what you have, or tell the member what is left.',
};

/** Find a member by id, or by exact (case-insensitive) name — models often pass names. */
function resolveMember(port: TeamPort, ref: string | undefined) {
  if (!ref) return undefined;
  const key = ref.trim().replace(/^@/, '').toLowerCase();
  return port.members().find((m) => m.bot.id === ref || m.bot.name.toLowerCase() === key);
}

/**
 * The default avatar for a proposed Bot (the member can change it on the card):
 * a plant hashed from the name — the same name always proposes the same plant —
 * from the implicit pool, so never the built-in Sprouty's reserved sprout.
 */
export function proposedAvatar(name: string): BotCreatePayload['avatar'] {
  return plantAvatarConfig(IMPLICIT_POOL[hashSeed(name) % IMPLICIT_POOL.length]!);
}

export function createTeamTool(ctx: BotTurnContext, port: TeamPort) {
  return tool({
    description: DESCRIPTION,
    inputSchema: teamSchema,
    execute: async (input: TeamInput) => {
      try {
        switch (input.action) {
          case 'list': {
            return {
              action: 'list',
              hand_offs_enabled: port.allowBotChat,
              members: port.members().map((m) => ({
                id: m.bot.id,
                name: m.bot.name,
                role: m.bot.role,
                member_role: m.role,
                ...(m.bot.id === ctx.bot.id ? { you: true } : {}),
              })),
              not_in_conversation: port.others().map((bot) => ({ id: bot.id, name: bot.name, role: bot.role })),
            };
          }

          case 'ask': {
            const target = resolveMember(port, input.bot_id);
            const message = input.message?.trim();
            if (!message) return { action: 'ask', status: 'refused', reason: 'message is required — write the brief.' };
            if (!target) return { action: 'ask', status: 'refused', reason: REFUSAL.not_member };
            const rejection = port.checkAsk(target.bot.id);
            if (rejection) return { action: 'ask', status: 'refused', reason: REFUSAL[rejection] };
            await port.acceptAsk(target.bot.id, message);
            return {
              action: 'ask',
              status: 'handed_over',
              to: target.bot.name,
              note: `${target.bot.name} answers next, in front of the member. End your turn now: at most one line on what you handed over. Do not answer for ${target.bot.name}.`,
            };
          }

          case 'add': {
            const ref = input.bot_id?.trim();
            if (!ref) return { action: 'add', status: 'refused', reason: 'bot_id is required (see list).' };
            if (resolveMember(port, ref))
              return { action: 'add', status: 'refused', reason: 'That Bot is already here.' };
            const key = ref.replace(/^@/, '').toLowerCase();
            const bot = port.others().find((b) => b.id === ref || b.name.toLowerCase() === key);
            if (!bot) {
              return {
                action: 'add',
                status: 'refused',
                reason: 'The member has no such Bot. Propose one with create if it would help.',
              };
            }
            const added = await port.addMember(bot.id);
            if (!added.ok) return { action: 'add', status: 'refused', reason: added.error };
            return {
              action: 'add',
              status: 'added',
              bot: { id: bot.id, name: bot.name, role: bot.role },
              note:
                port.kind === 'direct'
                  ? `${bot.name} joined as a guest: it speaks only when the member mentions it or you hand it work.`
                  : `${bot.name} joined the group.`,
            };
          }

          case 'create': {
            const name = validateBotName(input.name, '');
            if (!name.ok) return { action: 'create', status: 'refused', reason: name.error };
            const role = validateBotRole(input.role);
            if (!role.ok) return { action: 'create', status: 'refused', reason: role.error };
            const instructions = validateBotInstructions(input.instructions);
            if (!instructions.ok) return { action: 'create', status: 'refused', reason: instructions.error };
            const all = [...port.members().map((m) => m.bot), ...port.others()];
            if (all.some((bot) => bot.name.toLowerCase() === name.name.toLowerCase())) {
              return {
                action: 'create',
                status: 'refused',
                reason: `The member already has a Bot called ${name.name}. Invite it with add instead.`,
              };
            }
            const payload: BotCreatePayload = {
              name: name.name,
              role: role.role,
              instructions: instructions.instructions,
              avatar: proposedAvatar(name.name),
              template_key: null,
            };
            const request = await ctx.createRequest('bot_create', payload);
            return {
              action: 'create',
              status: 'proposed',
              request_id: request.id,
              note: `The member now sees a card to confirm or edit ${name.name}. It does not exist until they confirm — tell them in one line why you propose it, then stop. You are woken when it joins.`,
            };
          }
        }
      } catch (error) {
        return { action: input.action, error: toErrorMessage(error) };
      }
    },
  });
}
