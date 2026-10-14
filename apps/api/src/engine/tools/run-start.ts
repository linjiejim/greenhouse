import { z } from 'zod';
import { createScheduleInputSchema } from '@greenhouse/contract';
import type { Background } from '../background.js';
import { defineTool } from './define.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const backgroundOptionsSchema = createScheduleInputSchema.pick({
  computer: true,
  domains: true,
  continue_after: true,
});

/** Long work goes into a background run; the Agent can only propose it, the member starts it. */
export function runStartTool(background: Background) {
  return defineTool({
    name: 'run_start',
    description:
      'Propose a background run for long work: many steps, or anything that would keep the member waiting. Give a short title and a self-contained brief; the run may query only this source conversation, recall memories, read connectors and write by approval tiers. Declare computer use and required domains; local Docker computers stay offline. It starts when the member approves and reports back here.',
    input: z.object({
      ...backgroundOptionsSchema.shape,
      title: z.string().min(1).max(80),
      brief: z.string().min(1).max(2000),
    }),
    risk: 'read',
    surfaces: ['turn'],
    async execute(args, ctx) {
      const request = await ctx.raise({
        kind: 'proposal',
        subject: 'run_start',
        title:
          ctx.locale === 'zh'
            ? `${ctx.agent.name} 想开始一个后台运行：${args.title}`
            : `${ctx.agent.name} proposes a background run: ${args.title}`,
        payload: {
          run_title: args.title,
          brief: args.brief,
          computer: args.computer,
          domains: args.domains,
          continue_after: args.continue_after,
        },
        waits: false,
        expiresInMs: DAY_MS,
      });
      return { status: 'proposed', request_id: request.id };
    },
    async decide(request, ctx) {
      const title = String(request.payload.run_title ?? '');
      const zh = ctx.locale === 'zh';
      if (request.status !== 'approved') {
        return { line: zh ? `没有开始后台运行：${title}` : `Background run not started: ${title}`, note: null };
      }
      await background.start({
        agentId: ctx.agent.id,
        ownerId: ctx.memberId,
        requestedBy: ctx.memberId,
        title,
        brief: String(request.payload.brief ?? ''),
        source: 'conversation',
        sourceId: request.conversationId,
        conversationId: request.conversationId,
        parentRunId: request.runId,
        ...backgroundOptionsSchema.parse(request.payload),
        ...(typeof request.result?.continue_after === 'boolean'
          ? { continue_after: request.result.continue_after }
          : {}),
      });
      // The report arrives in this conversation when the run ends.
      return { line: zh ? `已开始后台运行：${title}` : `Background run started: ${title}`, note: null };
    },
    summarize: (args, _output, locale) =>
      locale === 'zh' ? `提议后台运行：${args.title}` : `Proposed a background run: ${args.title}`,
  });
}
