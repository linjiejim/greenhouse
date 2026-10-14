import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb, runs } from '@greenhouse/db';
import { defineTool } from './define.js';
import type { ComputersService } from '../../modules/computers/service.js';

export function runFinishTool(computers: ComputersService) {
  return defineTool({
    name: 'run_finish',
    description:
      'Finish background work with a report and findings. Use an empty findings array only when the task found nothing worth notifying the member about.',
    input: z.object({ report: z.string().max(20_000), findings: z.array(z.string().min(1).max(1000)).max(20) }),
    risk: 'read',
    surfaces: ['background'],
    available: (ctx) => ctx.runKind === 'background',
    async execute(args, ctx) {
      if (
        ctx.backgroundComputer &&
        (await computers.jobs(ctx.memberId, ctx.agent.id)).some((job) => job.status === 'running')
      )
        throw new Error('A computer process is still running. Wait for it before finishing this run.');
      await getDb()
        .update(runs)
        .set({ output: { text: args.report, findings: args.findings } })
        .where(eq(runs.id, ctx.runId));
      ctx.endTurn();
      return { report: args.report, findings: args.findings };
    },
  });
}
