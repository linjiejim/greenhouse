import { z } from 'zod';
import type { ComputersService } from '../../modules/computers/service.js';
import { defineTool } from './define.js';

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
    surfaces: ['turn'],
    available: async (ctx) => ctx.modules.computer && (await ctx.available('sandbox')),
    async execute(args, ctx) {
      switch (args.action) {
        case 'shell':
          return computers.shell(ctx.memberId, ctx.agent.id, args.command, args.timeout_s * 1000);
        case 'run_background': {
          const job = await computers.startJob(ctx.memberId, ctx.agent.id, args.command, args.name);
          if (ctx.conversation) {
            await computers.watch({
              memberId: ctx.memberId,
              agentId: ctx.agent.id,
              conversationId: ctx.conversation.id,
              jobRef: job.id,
              name: args.name ?? job.name ?? '',
            });
          }
          // Polling would only burn steps: the turn ends here and the Agent is woken when it ends.
          ctx.endTurn();
          return { id: job.id, note: 'It is running. You are woken here when it ends.' };
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
