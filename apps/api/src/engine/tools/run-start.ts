import { han, interpolate } from '@greenhouse/utils/i18n';
import { z } from 'zod';
import { createScheduleInputSchema } from '@greenhouse/contract';
import type { ProvidersService } from '../../providers/service.js';
import type { ComputersService } from '../../modules/computers/service.js';
import type { Background } from '../background.js';
import { defineTool } from './define.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const backgroundOptionsSchema = createScheduleInputSchema.pick({
  computer: true,
  domains: true,
  continue_after: true,
});

/** Long work goes into a background run; the Agent can only propose it, the member starts it. */
export function runStartTool(background: Background, computers: ComputersService, providers: ProvidersService) {
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
      const network = args.computer ? await computers.backgroundNetwork(ctx.memberId, ctx.agent.id) : null;
      const sites = args.domains.join(' · ');
      const enabled = (name: string) => ctx.manifest.tools === null || ctx.manifest.tools.includes(name);
      const web = await providers.available('search', { memberId: ctx.memberId });
      const search = web && enabled('web_search');
      const read = web && enabled('web_fetch');
      const zh = ctx.locale === 'zh';
      const webLabel = zh
        ? search && read
          ? '使用搜索和网页阅读'
          : search
            ? '使用搜索'
            : read
              ? '使用网页阅读'
              : '本运行未启用搜索或网页阅读'
        : search && read
          ? 'Search and page reading'
          : search
            ? 'Search'
            : read
              ? 'Page reading'
              : 'Search and page reading are not enabled for this run';
      const accessSummary =
        network === 'domains'
          ? zh
            ? han`使用电脑 · 可访问的域名：${sites || '无（离线）'}`
            : `Computer · Allowed domains: ${sites || 'None (offline)'}`
          : [
              ...(network === 'offline' ? [zh ? '电脑仅用于离线工作' : 'Computer for offline work only'] : []),
              zh
                ? `${webLabel}${sites ? ` · 研究网站：${sites}` : ''}`
                : `${webLabel}${sites ? ` · Research sites: ${sites}` : ''}`,
            ].join('\n');
      const request = await ctx.raise({
        kind: 'proposal',
        subject: 'run_start',
        title:
          ctx.locale === 'zh'
            ? interpolate('zh', '{name} 想开始一个后台运行：{title}', { name: ctx.agent.name, title: args.title })
            : `${ctx.agent.name} proposes a background run: ${args.title}`,
        payload: {
          run_title: args.title,
          access_summary: accessSummary,
          brief: args.brief,
          computer: args.computer,
          domains: args.domains,
          continue_after: args.continue_after,
        },
        waits: false,
        expiresInMs: DAY_MS,
      });
      return {
        status: 'proposed',
        status_label: zh ? '已提议，等你确认' : 'Proposed, awaiting your confirmation',
        access_summary: accessSummary,
        request_id: request.id,
      };
    },
    async decide(request, ctx) {
      const title = String(request.payload.run_title ?? '');
      const zh = ctx.locale === 'zh';
      if (request.status !== 'approved') {
        return { line: zh ? han`没有开始后台运行：${title}` : `Background run not started: ${title}`, note: null };
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
      return { line: zh ? han`已开始后台运行：${title}` : `Background run started: ${title}`, note: null };
    },
    summarize: (args, _output, locale) =>
      locale === 'zh' ? han`提议后台运行：${args.title}` : `Proposed a background run: ${args.title}`,
  });
}
