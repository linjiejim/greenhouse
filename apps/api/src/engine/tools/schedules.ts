import { z } from 'zod';
import type { SchedulesService } from '../../modules/schedules/service.js';
import { argumentDetails } from './presentation.js';
import { defineTool } from './define.js';
import { backgroundOptionsSchema } from './run-start.js';

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
      const summary = {
        create: zh
          ? `新建定时「${'name' in args ? args.name : ''}」`
          : `create the schedule "${'name' in args ? args.name : ''}"`,
        update: zh ? '修改一个定时' : 'change a schedule',
        pause: zh ? '暂停一个定时' : 'pause a schedule',
        resume: zh ? '恢复一个定时' : 'resume a schedule',
        delete: zh ? '删除一个定时' : 'delete a schedule',
      }[args.action];
      const { action: _action, ...values } = args;
      const schedule =
        'id' in args
          ? (await schedules.list(ctx.memberId, ctx.agent.id)).find((schedule) => schedule.id === args.id)
          : null;
      const details = argumentDetails(
        Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'id')),
        ctx.locale,
      );
      if ('id' in args)
        details.unshift({
          label: zh ? '定时' : 'Schedule',
          value: schedule?.name ?? (zh ? '不可用的定时' : 'Unavailable schedule'),
        });
      return { summary, details };
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
