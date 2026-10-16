import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { agents, getDb } from '@greenhouse/db';
import type { Engine } from '../engine.js';
import { defineTool } from './define.js';
import { han } from '@greenhouse/utils/i18n';

/** Bring another of the member's Agents into this conversation with a brief; it answers next. */
export function handoffTool(handOff: Engine['handOff']) {
  return defineTool({
    name: 'handoff',
    description:
      "Call this tool to hand part of the work to another of the member's Agents (by name or id) with a precise, self-contained brief. Saying you handed it over does not transfer anything. On success it joins this conversation if it is not here, answers next where the member can see it, and your turn ends right away: say in one line what you handed over and never answer on its behalf.",
    input: z.object({
      agent: z.string().min(1).max(80),
      brief: z.string().min(1).max(2000),
    }),
    risk: 'read',
    surfaces: ['turn'],
    async available(ctx) {
      const [other] = await getDb()
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.ownerId, ctx.memberId), eq(agents.isMain, false), isNull(agents.archivedAt)))
        .limit(1);
      return !!other;
    },
    async execute(args, ctx) {
      if (!ctx.conversation) throw new Error('Hand-offs happen in a conversation.');
      const wanted = args.agent.trim();
      const id = wanted.startsWith('agent:') ? wanted.slice('agent:'.length) : wanted;
      const candidates = await getDb()
        .select({ id: agents.id, name: agents.name, isMain: agents.isMain })
        .from(agents)
        .where(and(eq(agents.ownerId, ctx.memberId), isNull(agents.archivedAt)));
      const target =
        candidates.find((agent) => agent.id === id) ??
        (wanted === 'main' ? candidates.find((agent) => agent.isMain) : undefined) ??
        candidates.find((agent) => agent.name.toLowerCase() === wanted.toLowerCase());
      if (!target) {
        return {
          error: `There is no Agent called "${wanted}". These are available: ${candidates.map((agent) => agent.name).join(', ')}.`,
        };
      }
      if (target.id === ctx.agent.id) return { error: 'You cannot hand work to yourself.' };
      await handOff({
        conversationId: ctx.conversation.id,
        fromAgentId: ctx.agent.id,
        toAgentId: target.id,
        memberId: ctx.memberId,
        brief: args.brief,
        chain: ctx.chain ?? { key: ctx.runId, path: [ctx.agent.id] },
        locale: ctx.locale,
      });
      ctx.endTurn();
      return {
        handed_to: target.name,
        note: 'It answers next. End your turn with one line saying what you handed over.',
      };
    },
    summarize: (_args, output, locale) => {
      const name = (output as { handed_to?: string } | undefined)?.handed_to ?? '';
      return locale === 'zh' ? han`交给了 ${name}` : `Handed over to ${name}`;
    },
  });
}
