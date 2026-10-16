import { z } from 'zod';
import type { SchedulesService } from '../../modules/schedules/service.js';
import { describeCron } from '@greenhouse/utils/cron';
import { getDb, members } from '@greenhouse/db';
import { eq } from 'drizzle-orm';
import { defineTool } from './define.js';
import { backgroundOptionsSchema } from './run-start.js';
import { han } from '@greenhouse/utils/i18n';

/** The Agent's own schedules: reading them is free, changing them waits for the member. */
export function scheduleTools(schedules: SchedulesService) {
  const query = defineTool({
    name: 'schedule_query',
    description: 'List your schedules: what you run on a timer, when, and how the last run went.',
    input: z.object({}),
    risk: 'read',
    idempotent: true,
    surfaces: ['turn'],
    async execute(_args, ctx) {
      const items = await schedules.list(ctx.memberId, ctx.agent.id);
      return {
        schedules: items.map((item) => ({
          id: item.id,
          name: item.name,
          cron: item.cron,
          timezone: item.timezone,
          status: item.status,
          next_run_at: item.next_run_at,
          last_status: item.last_status,
          quiet: item.quiet,
        })),
      };
    },
    summarize: (_args, _output, locale) => (locale === 'zh' ? '查看了定时' : 'Checked schedules'),
  });

  const mutation = defineTool({
    name: 'schedule_mutation',
    description:
      'Create, change, pause, resume or delete one of the member’s schedules. On create, agent_id selects another owned Agent (for example one just created); omit it for yourself. A schedule runs a self-contained brief in the background on a cron time (five fields: minute hour day month weekday, at most every 15 minutes) and reports back to your thread. The member approves the change first.',
    input: z.discriminatedUnion('action', [
      z.object({
        action: z.literal('create'),
        agent_id: z.string().min(1).max(64).optional(),
        ...backgroundOptionsSchema.shape,
        quiet: z.boolean().default(false),
        name: z.string().min(1).max(80),
        brief: z.string().min(1).max(2000),
        cron: z.string().min(9).max(100),
        timezone: z.string().max(64).optional(),
      }),
      z.object({
        action: z.literal('update'),
        ...backgroundOptionsSchema.partial().shape,
        quiet: z.boolean().optional(),
        id: z.string(),
        name: z.string().min(1).max(80).optional(),
        brief: z.string().min(1).max(2000).optional(),
        cron: z.string().min(9).max(100).optional(),
      }),
      z.object({ action: z.enum(['pause', 'resume', 'delete']), id: z.string() }),
    ]),
    risk: 'write',
    callRisk: async (args) => (args.action === 'delete' ? 'tier3' : 'tier2'),
    async describe(args, ctx) {
      const zh = ctx.locale === 'zh';
      let summary = {
        create: zh
          ? han`新建定时「${'name' in args ? args.name : ''}」`
          : `create the schedule "${'name' in args ? args.name : ''}"`,
        update: zh ? '修改一个定时' : 'change a schedule',
        pause: zh ? '暂停一个定时' : 'pause a schedule',
        resume: zh ? '恢复一个定时' : 'resume a schedule',
        delete: zh ? '删除一个定时' : 'delete a schedule',
      }[args.action];
      const schedule = 'id' in args ? await schedules.get(ctx.memberId, args.id) : null;
      const [member] = await getDb()
        .select({ timezone: members.timezone })
        .from(members)
        .where(eq(members.id, ctx.memberId));
      const details: { label: string; value: string }[] = [];
      const add = (zhLabel: string, enLabel: string, value: string) =>
        details.push({ label: zh ? zhLabel : enLabel, value });
      if (schedule) {
        add('定时', 'Schedule', schedule.name);
        const verbs = {
          update: ['修改', 'Change'],
          pause: ['暂停', 'Pause'],
          resume: ['恢复', 'Resume'],
          delete: ['删除', 'Delete'],
        };
        const verb = verbs[args.action as keyof typeof verbs];
        if (verb) summary = zh ? han`${verb[0]}定时「${schedule.name}」` : `${verb[1]} schedule “${schedule.name}”`;
      }
      add(
        'Agent',
        'Agent',
        schedule?.agent_id ?? ('agent_id' in args ? (args.agent_id ?? ctx.agent.id) : ctx.agent.name),
      );
      if ('name' in args && args.name && args.action === 'update') add('新名称', 'New name', args.name);
      if ('brief' in args && args.brief) add('要做什么', 'Work', args.brief);
      if ('cron' in args && args.cron) add('执行时间', 'Timing', describeCron(args.cron, ctx.locale));
      const timezone = 'timezone' in args ? (args.timezone ?? member?.timezone) : schedule?.timezone;
      if (timezone && timezone !== member?.timezone) add('时区', 'Time zone', timezone);
      if ('computer' in args && args.computer === true) add('电脑', 'Computer', zh ? '使用电脑' : 'Use a computer');
      if ('computer' in args && args.computer === false && args.action === 'update')
        add('电脑', 'Computer', zh ? '改为不使用电脑' : 'Stop using a computer');
      if ('domains' in args && args.domains?.length) add('可访问的网站', 'Allowed sites', args.domains.join(' · '));
      if ('domains' in args && !args.domains?.length && args.action === 'update')
        add('可访问的网站', 'Allowed sites', zh ? '移除指定网站' : 'Remove the specified sites');
      if ('continue_after' in args && (args.continue_after || args.action === 'update'))
        add(
          '完成后',
          'On completion',
          args.continue_after
            ? zh
              ? '继续对话'
              : 'Continue the conversation'
            : zh
              ? '仅汇报结果'
              : 'Report the result only',
        );
      if ('quiet' in args && (args.quiet || args.action === 'update'))
        add(
          '通知',
          'Notifications',
          args.quiet
            ? zh
              ? '有发现时通知'
              : 'Notify when there are findings'
            : zh
              ? '每次完成都通知'
              : 'Notify on every completion',
        );
      if (ctx.conversation?.kind === 'room') summary = zh ? '管理一个定时' : 'Manage a schedule';
      return { summary, details, ...(args.action === 'delete' ? { danger: true } : {}) };
    },
    async execute(args, ctx) {
      switch (args.action) {
        case 'create': {
          const created = await schedules.create(ctx.memberId, {
            agent_id: args.agent_id ?? ctx.agent.id,
            name: args.name,
            brief: args.brief,
            cron: args.cron,
            quiet: args.quiet,
            computer: args.computer,
            domains: args.domains,
            continue_after: args.continue_after,
            ...(args.timezone ? { timezone: args.timezone } : {}),
          });
          return { created: created.id, next_run_at: created.next_run_at };
        }
        case 'update': {
          const { action: _action, id, ...changes } = args;
          const updated = await schedules.update(ctx.memberId, id, changes);
          return { updated: updated.id, next_run_at: updated.next_run_at };
        }
        case 'pause':
          return { paused: (await schedules.pause(ctx.memberId, args.id)).id };
        case 'resume':
          return { resumed: (await schedules.resume(ctx.memberId, args.id)).id };
        case 'delete':
          await schedules.remove(ctx.memberId, args.id);
          return { deleted: args.id };
      }
    },
    summarize: (args, _output, locale) => (locale === 'zh' ? '修改了定时' : 'Changed a schedule'),
  });

  return [query, mutation];
}
