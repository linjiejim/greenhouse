import { z } from 'zod';
import { getDb, members } from '@greenhouse/db';
import { eq } from 'drizzle-orm';
import { defineTool } from './define.js';
import { ApiError } from '../../http/errors.js';
import type { RemindersService } from '../../modules/reminders/service.js';

export function remindTool(reminders: RemindersService) {
  return defineTool({
    name: 'remind',
    description:
      'Create, list or cancel a one-off personal reminder in this thread. Convert the member’s local time using their time zone in context and supply due_at as ISO 8601 with UTC offset. Due reminders post in the thread and notify the member. Private reversible writes run immediately with receipt and undo. For recurring work use schedule_mutation.',
    input: z.discriminatedUnion('action', [
      z.object({
        action: z.literal('create'),
        text: z.string().trim().min(1).max(1000),
        due_at: z.iso.datetime({ offset: true }),
      }),
      z.object({
        action: z.literal('list'),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      z.object({ action: z.literal('cancel'), id: z.string().min(1).max(64) }),
    ]),
    risk: 'read',
    surfaces: ['turn'],
    available: (ctx) => !ctx.publicAgent,
    callRisk: async (args) => (args.action === 'list' ? 'read' : 'tier1'),
    async turnContext(ctx) {
      const [m] = await getDb()
        .select({ timezone: members.timezone })
        .from(members)
        .where(eq(members.id, ctx.memberId));
      return `Reminder time zone: ${m?.timezone ?? 'UTC'}`;
    },
    async guard(_args, ctx) {
      if (!ctx.conversation || ctx.conversation.kind === 'room')
        throw new ApiError(403, 'private_conversation_required', 'Reminders need your own private conversation.');
    },
    async before(args, ctx) {
      return args.action === 'cancel'
        ? { input: args, previous: await reminders.get(ctx.memberId, args.id, ctx.conversation!.id) }
        : args.action === 'create'
          ? { input: args }
          : null;
    },
    async execute(args, ctx) {
      if (args.action === 'create') return reminders.create(ctx.memberId, ctx.conversation!.id, ctx.agent.id, args);
      if (args.action === 'list') return reminders.list(ctx.memberId, ctx.conversation!.id, args);
      return reminders.cancel(ctx.memberId, args.id, ctx.conversation!.id);
    },
    async undo(args, output, before, ctx) {
      const result = output as { id: string; revision: number };
      const lineage = ctx.undoRevisions?.get(result.id);
      const revision = lineage?.written === result.revision ? lineage.current : result.revision;
      await reminders.undo(ctx.memberId, result.id, revision, args.action === 'create' ? 'canceled' : 'pending');
      const prior = (before as { previous?: { revision: number } }).previous;
      if (prior) ctx.undoRevisions?.set(result.id, { written: prior.revision, current: revision + 1 });
    },
    summarize: (args, out, locale) => {
      if (args.action === 'list') return locale === 'zh' ? '查看了提醒' : 'Checked reminders';
      const text = (out as { text?: string } | undefined)?.text ?? (args.action === 'create' ? args.text : '');
      const verb =
        args.action === 'cancel'
          ? locale === 'zh'
            ? '取消了提醒'
            : 'Canceled reminder'
          : locale === 'zh'
            ? '设好了提醒'
            : 'Set reminder';
      return `${verb}${text ? (locale === 'zh' ? `：${text}` : `: ${text}`) : ''}`;
    },
  });
}
