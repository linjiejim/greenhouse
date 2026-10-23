/**
 * The report templates Greenhouse ships with — a weekly report and a project
 * review deck — seeded on first boot only, while the workspace has never had
 * a template. They are ordinary team templates afterwards: a super may edit
 * or delete them, and a deleted one does not come back on the next boot.
 */

import type { DatabaseProvider, ReportTemplateCreateInput } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { checkReportTemplateDefinition, type ReportTemplateDefinition } from '@greenhouse/types/reports';

export const DEFAULT_REPORT_TEMPLATES: readonly ReportTemplateDefinition[] = [
  {
    name: '周报 Weekly report',
    description: '团队周报：结论先行，数据、进展、风险、下周计划。A weekly status report: conclusion first.',
    kind: 'report',
    formats: ['pdf', 'docx'],
    cover_fields: [
      { key: 'title', required: true },
      { key: 'period', required: true },
      { key: 'author', required: false },
      { key: 'date', required: false },
    ],
    sections: [
      {
        key: 'summary',
        title: '本周摘要',
        guidance:
          '用 3–5 句话说清本周最重要的结论、进展和需要关注的事，先写结论。In 3–5 sentences: the week’s key conclusions first.',
        required: true,
        content: 'markdown',
      },
      {
        key: 'metrics',
        title: '关键数据',
        guidance:
          '2–6 个关键指标：数值 + 名称，可在 note 里写对比（环比、目标）。2–6 key figures with an optional comparison note.',
        required: false,
        content: 'figures',
      },
      {
        key: 'progress',
        title: '本周进展',
        guidance: '按项目或目标列出完成的事，每条一句，写结果而不是过程。One line per outcome, results not activity.',
        required: true,
        content: 'bullets',
      },
      {
        key: 'risks',
        title: '问题与风险',
        guidance:
          '表格列建议：问题 | 影响 | 负责人 | 应对。没有就省略本节。Suggested columns: Issue | Impact | Owner | Response.',
        required: false,
        content: 'table',
      },
      {
        key: 'next_week',
        title: '下周计划',
        guidance: '下周要完成的事，每条写清负责人或截止时间。Next week’s commitments, each with an owner or date.',
        required: true,
        content: 'bullets',
      },
      {
        key: 'asks',
        title: '需要的支持',
        guidance: '需要谁做什么决定或给什么资源。没有就省略。Decisions or help needed, and from whom.',
        required: false,
        content: 'bullets',
      },
    ],
  },
  {
    name: '项目汇报 Project review',
    description: '项目阶段汇报演示稿：概况、成果、里程碑、风险、下一步。A project review deck.',
    kind: 'presentation',
    formats: ['pptx', 'pdf'],
    cover_fields: [
      { key: 'title', required: true },
      { key: 'subtitle', required: false },
      { key: 'author', required: false },
      { key: 'date', required: true },
    ],
    sections: [
      {
        key: 'overview',
        title: '项目概况',
        guidance: '目标、范围、当前阶段，一页能读完。Goal, scope and current phase — fits on one slide.',
        required: true,
        content: 'markdown',
      },
      {
        key: 'highlights',
        title: '关键成果',
        guidance: '2–4 个最能说明进展的数字，note 写对比或口径。2–4 headline numbers.',
        required: true,
        content: 'figures',
      },
      {
        key: 'milestones',
        title: '里程碑',
        guidance:
          '表格列建议：里程碑 | 计划日期 | 状态 | 说明。Suggested columns: Milestone | Planned | Status | Note.',
        required: true,
        content: 'table',
      },
      {
        key: 'risks',
        title: '风险与问题',
        guidance: '每条写清风险、影响和应对。Each risk with its impact and response.',
        required: false,
        content: 'bullets',
      },
      {
        key: 'next_steps',
        title: '下一步',
        guidance: '接下来要做的事和时间点。What happens next, with dates.',
        required: true,
        content: 'bullets',
      },
      {
        key: 'decisions',
        title: '需要决策',
        guidance: '需要听众拍板的事项，没有就省略。Decisions needed from the audience.',
        required: false,
        content: 'bullets',
      },
    ],
  },
];

/** Seed the shipped templates once. Never blocks boot. */
export async function seedDefaultReportTemplates(db: DatabaseProvider): Promise<number> {
  try {
    const rows: ReportTemplateCreateInput[] = DEFAULT_REPORT_TEMPLATES.map((definition) => {
      const checked = checkReportTemplateDefinition(definition);
      if (!checked.ok) throw new Error(`default template "${definition.name}": ${checked.errors.join(' ')}`);
      return { ...checked.value, visibility: 'team', owner_user_id: null, is_default: true, created_by: null };
    });
    const inserted = await db.reportTemplates.seedIfNeverUsed(rows);
    if (inserted) logger.info(`[reports] seeded ${inserted} default report templates`);
    return inserted;
  } catch (error) {
    logger.warn(`[reports] could not seed the default report templates: ${toErrorMessage(error)}`);
    return 0;
  }
}
