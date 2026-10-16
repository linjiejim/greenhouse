import { z } from 'zod';
import { appAgentQuerySchema, appExecuteSchema } from '@greenhouse/contract';
import type { AppsService } from '../../modules/apps/service.js';
import type { TablesService } from '../../modules/tables/service.js';
import { defineTool } from './define.js';
import { tableTools } from './tables.js';

export function appTools(apps: AppsService, tables: TablesService) {
  const plans = new WeakMap<object, Awaited<ReturnType<typeof apps.actionPlan>>>();
  const mutation = tableTools(tables).find((tool) => tool.name === 'table_mutation')!;
  const query = defineTool({
    name: 'apps_query',
    description:
      'List usable apps, read their published pages, query a saved card or read a record through that card. App roles narrow the member’s base permissions.',
    input: appAgentQuerySchema,
    summarize: (_args, _output, locale) => (locale === 'zh' ? '查看了应用' : 'Viewed apps'),
    risk: 'read',
    idempotent: true,
    private: true,
    taints: true,
    available: (ctx) => ctx.modules.apps,
    async execute(args, ctx) {
      if (args.action === 'list') return apps.list(ctx.memberId, args);
      if (args.action === 'get') return apps.runtime(ctx.memberId, args.app_id);
      if (args.action === 'query') return apps.card(ctx.memberId, args.app_id, args);
      const detail = await apps.record(ctx.memberId, args.app_id, args, args.record_id);
      const at = await tables.scopeLabel(ctx.memberId, detail.table_id);
      ctx.cite?.(
        {
          kind: 'record',
          id: detail.record.id,
          title: String(detail.record.values[at.primary_id ?? ''] ?? at.name),
          url: `${at.href}?record=${detail.record.id}`,
        },
        'read',
      );
      return detail;
    },
  });
  const action = defineTool({
    name: 'apps_action',
    description:
      'Execute a saved app action or submit a published form as the member. The card shows server-resolved values. Private reversible writes have undo; shared writes use per-table approval. Never accepts a new app specification.',
    input: appExecuteSchema.extend({ app_id: z.string().max(64) }),
    risk: 'write',
    surfaces: ['turn', 'background'],
    available: (ctx) => ctx.modules.apps && ctx.modules.tables,
    async guard(args, ctx) {
      await apps.inActionScope(ctx.memberId, args.app_id, args.version, args.card, (tableId) =>
        tables.lockWriteScope(ctx.memberId, tableId),
      );
    },
    async callRisk(args, ctx) {
      const plan = await apps.actionPlan(ctx.memberId, args.app_id, args);
      return (await tables.writeScope(ctx.memberId, plan.table_id)).tier;
    },
    async approvalScope(args, ctx) {
      const plan = await apps.actionPlan(ctx.memberId, args.app_id, args);
      return { type: 'table', id: plan.table_id, actions: [`table.${plan.action}`] };
    },
    async describe(args, ctx) {
      const plan = await apps.actionPlan(ctx.memberId, args.app_id, args);
      return apps.inActionScope(ctx.memberId, args.app_id, args.version, args.card, async () => {
        const card = await mutation.describe!(plan, ctx);
        return {
          ...card,
          details: [{ label: ctx.locale === 'zh' ? '应用动作' : 'App action', value: plan.label }, ...card.details],
        };
      });
    },
    async before(args, ctx) {
      const plan = await apps.actionPlan(ctx.memberId, args.app_id, args);
      plans.set(args, plan);
      return { ...((await mutation.before!(plan, ctx)) as object), input: args, plan };
    },
    execute: (args, ctx) => apps.execute(ctx.memberId, args.app_id, args),
    async undo(args, output, before, ctx) {
      return apps.inActionScope(ctx.memberId, args.app_id, args.version, args.card, () =>
        mutation.undo!((before as { plan: unknown }).plan, output, before, ctx),
      );
    },
    async receipt(args, output, ctx) {
      return apps.inActionScope(ctx.memberId, args.app_id, args.version, args.card, async () =>
        mutation.receipt!(plans.get(args)!, output, ctx),
      );
    },
    undoResult: mutation.undoResult,
    summarize: (_args, _output, locale) => (locale === 'zh' ? '执行了应用动作' : 'Ran an app action'),
  });
  return [query, action];
}
