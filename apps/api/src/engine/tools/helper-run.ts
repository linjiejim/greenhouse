import { z } from 'zod';
import type { Background } from '../background.js';
import { defineTool } from './define.js';
import { han } from '@greenhouse/utils/i18n';

export function helperRunTool(background: Background) {
  return defineTool({
    name: 'helper_run',
    description:
      'Start up to three read-only helper runs per turn. Give each a self-contained brief, with only the facts it needs: helpers have clean context, no transcript or memory index, eight steps and a budget reservation. This turn waits; only their summaries wake you through run_report. Use for independent research, never for writes.',
    input: z.object({
      briefs: z
        .array(z.object({ title: z.string().trim().min(1).max(80), brief: z.string().trim().min(1).max(2000) }))
        .min(1)
        .max(3),
    }),
    available: (ctx) => ctx.mainAgent === true,
    risk: 'read',
    surfaces: ['turn'],
    async execute(args, ctx) {
      const helpers = await background.helpers({ parentRunId: ctx.runId, memberId: ctx.memberId, briefs: args.briefs });
      ctx.waitForRuns?.();
      return {
        status: 'waiting',
        runs: helpers.map((run) => ({ id: run.id, title: run.title })),
        note: 'End this turn. You will receive only the helper summaries when all finish.',
      };
    },
    summarize: (args, _output, locale) =>
      locale === 'zh' ? han`开始了 ${args.briefs.length} 个子运行` : `Started ${args.briefs.length} helper runs`,
  });
}
