import type { Hub } from '../../realtime/hub.js';
import { z } from 'zod';
import { REACTION_EMOJIS, todoItemSchema } from '@greenhouse/contract';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, runs } from '@greenhouse/db';
import type { ConversationsService } from '../../modules/conversations/service.js';
import { ApiError } from '../../http/errors.js';
import { defineTool } from './define.js';

export function messageTools(conversations: ConversationsService, hub: Hub) {
  return [
    defineTool({
      name: 'send_message',
      description:
        'Post a useful message in this thread during a wake-up. Your other text is private scratch. Stay silent when nothing needs attention; never send empty acknowledgements. Ends this wake-up after posting. Member turns use the final reply instead. This does not finish background runs; use run_finish there.',
      input: z.object({ text: z.string().trim().min(1).max(20_000) }),
      risk: 'read',
      surfaces: ['background'],
      available: (ctx) => ctx.runKind === 'turn',
      async execute(args, ctx) {
        if (!ctx.eventWoken || !ctx.postMessage)
          throw new ApiError(403, 'message_surface', 'Messages may only be posted by an event-woken turn.');
        await ctx.postMessage(args.text);
        ctx.endTurn();
        return { sent: true };
      },
      summarize: (_args, _out, locale) => (locale === 'zh' ? '发出了消息' : 'Sent a message'),
    }),
    defineTool({
      name: 'react',
      description:
        'Acknowledge the member’s latest message in the current turn with one emoji instead of a text reply. Ends this turn. Use only when an acknowledgement is enough.',
      input: z.object({ emoji: z.enum(REACTION_EMOJIS) }),
      risk: 'read',
      surfaces: ['turn'],
      publicAgent: true,
      async execute(args, ctx) {
        if (!ctx.conversation) throw new ApiError(400, 'conversation_required', 'A reaction needs a conversation.');
        const messageId = await conversations.react(
          ctx.memberId,
          ctx.conversation.id,
          ctx.agent.id,
          ctx.runId,
          args.emoji,
        );
        ctx.endTurn();
        return { reacted: messageId, emoji: args.emoji };
      },
      summarize: (_args, _out, locale) => (locale === 'zh' ? '回应了消息' : 'Reacted to the message'),
    }),
    defineTool({
      name: 'todo',
      description:
        'Maintain a short plan for long work. Replace the current run’s items with their latest statuses. Use this instead of narrating progress; the member sees it in the reply and run detail. Do not use for simple questions.',
      input: z.object({ items: z.array(todoItemSchema).min(1).max(20) }),
      risk: 'read',
      surfaces: ['turn', 'background'],
      publicAgent: true,
      async execute(args, ctx) {
        const [saved] = await getDb()
          .update(runs)
          .set({
            checkpoint: sql`coalesce(${runs.checkpoint}, '{}'::jsonb) || ${JSON.stringify({ todo: args.items })}::jsonb`,
          })
          .where(and(eq(runs.id, ctx.runId), eq(runs.ownerId, ctx.memberId), eq(runs.desiredState, 'run')))
          .returning({ id: runs.id, conversationId: runs.conversationId, status: runs.status });
        if (!saved) throw new ApiError(404, 'not_found', 'Run not found.');
        await ctx.setTodo?.(args.items);
        const event = {
          type: 'run.updated' as const,
          data: { run_id: saved.id, conversation_id: saved.conversationId, status: saved.status },
        };
        if (ctx.conversation) await conversations.publish(ctx.conversation.id, event);
        else hub.publish([ctx.memberId], event);
        return { items: args.items };
      },
      summarize: (_args, _out, locale) => (locale === 'zh' ? '更新了计划' : 'Updated the plan'),
    }),
  ];
}
