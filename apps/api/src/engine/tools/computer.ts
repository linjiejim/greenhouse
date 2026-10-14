import { z } from 'zod';
import type { ComputersService } from '../../modules/computers/service.js';
import { defineTool, type AvailabilityContext } from './define.js';

/**
 * Whether the Agent has a computer this turn: the member has computers on and a sandbox is set
 * up. A public Agent uses the asker's own copy of its computer, when its publication grants one.
 */
export const computerAvailable = async (ctx: AvailabilityContext) =>
  ctx.modules.computer &&
  (ctx.surface !== 'background' || ctx.backgroundComputer === true) &&
  (!ctx.publicAgent || ctx.publicAgent.computer) &&
  (await ctx.available('sandbox'));

/** The Agent's own computer: a shell, and background processes that wake it when they end. */
export function computerTool(computers: ComputersService) {
  return defineTool({
    name: 'computer',
    description:
      'Your own computer, a Linux sandbox with a home that persists. `shell` runs a command in ~/work (at most 120 s). Anything longer (a build, a download, a data run) goes to `run_background`: it keeps running after your turn, and you are woken in this conversation when it ends, so end your turn instead of polling. `processes`, `process_log` and `stop_process` manage background processes. A long job should write its progress to files, so that if it is lost when the computer restarts it can resume from them.',
    input: z.discriminatedUnion('action', [
      z.object({
        action: z.literal('shell'),
        command: z.string().min(1).max(8000),
        timeout_s: z.number().int().min(1).max(120).default(60),
      }),
      z.object({
        action: z.literal('run_background'),
        command: z.string().min(1).max(8000),
        name: z.string().min(1).max(60).optional(),
      }),
      z.object({ action: z.literal('processes') }),
      z.object({
        action: z.literal('process_log'),
        id: z.string().min(1).max(20),
        lines: z.number().int().min(1).max(2000).default(200),
      }),
      z.object({ action: z.literal('stop_process'), id: z.string().min(1).max(20) }),
    ]),
    risk: 'read',
    taints: true,
    outbound: true,
    surfaces: ['turn', 'background'],
    publicAgent: true,
    available: computerAvailable,
    async execute(args, ctx) {
      await computers.assertRunAccess(ctx.memberId, ctx.agent.id, ctx.runId);
      if (ctx.eventWoken && !['processes', 'process_log'].includes(args.action))
        throw new Error('An event can inspect process output. New computer work needs an approved brief.');
      if (ctx.surface === 'background' && !ctx.backgroundComputer)
        throw new Error('The brief did not declare a computer.');
      switch (args.action) {
        case 'shell':
          return computers.shell(ctx.memberId, ctx.agent.id, args.command, args.timeout_s * 1000);
        case 'run_background': {
          const job = await computers.startJob(ctx.memberId, ctx.agent.id, args.command, args.name);
          if (ctx.conversation && ctx.surface === 'turn') {
            await computers.watch({
              memberId: ctx.memberId,
              agentId: ctx.agent.id,
              conversationId: ctx.conversation.id,
              jobRef: job.id,
              name: args.name ?? job.name ?? '',
            });
          }
          // Polling would only burn steps: the turn ends here and the Agent is woken when it ends.
          if (ctx.surface === 'turn') ctx.endTurn();
          return {
            id: job.id,
            note:
              ctx.surface === 'background'
                ? 'It is running. Check processes and its log until it finishes before reporting this run complete.'
                : 'It is running. You are woken here when it ends.',
          };
        }
        case 'processes':
          return { processes: await computers.jobs(ctx.memberId, ctx.agent.id) };
        case 'process_log':
          return { log: await computers.jobLog(ctx.memberId, ctx.agent.id, args.id, args.lines) };
        case 'stop_process':
          return computers.stopJob(ctx.memberId, ctx.agent.id, args.id);
      }
    },
    summarize: (args, _output, locale) => {
      const zh = locale === 'zh';
      switch (args.action) {
        case 'shell':
          return zh ? `运行了命令：${args.command.slice(0, 60)}` : `Ran: ${args.command.slice(0, 60)}`;
        case 'run_background':
          return zh
            ? `在后台启动了：${args.name ?? args.command.slice(0, 40)}`
            : `Started in the background: ${args.name ?? args.command.slice(0, 40)}`;
        case 'processes':
          return zh ? '查看了后台进程' : 'Checked background processes';
        case 'process_log':
          return zh ? '读了进程输出' : 'Read process output';
        case 'stop_process':
          return zh ? '停止了一个进程' : 'Stopped a process';
      }
    },
  });
}
