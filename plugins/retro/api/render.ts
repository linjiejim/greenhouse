/**
 * The retro document — Markdown rendered from the aggregates (pure, no I/O).
 * The team reads it in Chinese, like the rest of its knowledge base.
 */

import type { RetroSuggestionsSkipReason } from '@greenhouse/types/hub-context';
import { type FrictionErrorClass, type RetroAggregates } from '@greenhouse/api/extension-kit';

export const RETRO_FOLDER_NAME = '复盘';

export function retroTitle(month: string): string {
  return `${month} 复盘`;
}

export type RetroSuggestions = { ok: true; text: string } | { ok: false; reason: RetroSuggestionsSkipReason };

const SKIP_COPY: Record<RetroSuggestionsSkipReason, string> = {
  over_budget: '本次没有写建议：团队本月的模型额度已用完（管理员可在「服务与计价」调整）。',
  no_model: '本次没有写建议：这台 Greenhouse 没有配置可用的模型。',
  failed: '本次没有写建议：调用模型失败，可稍后在「问题与需求」重新生成本月复盘。',
};

const FRICTION_KIND_COPY: Record<string, string> = {
  tool_error: '工具报错',
  wrong_params: '参数不对',
  detour: '绕了远路',
  data_quirk: '数据问题',
  capability_gap: '能力缺口',
};

const ERROR_CLASS_COPY: Record<FrictionErrorClass, string> = {
  not_found: '找不到对象',
  permission: '没有权限',
  invalid_input: '输入不合法',
  conflict: '冲突',
  limit: '额度或限流',
  timeout: '超时',
  empty_result: '结果为空',
  other: '其他',
};

const STATUS_COPY: Record<string, string> = {
  pending: '待处理',
  accepted: '已接受',
  rejected: '已拒绝',
  done: '已完成',
  new: '新',
  acknowledged: '已确认',
  resolved: '已解决',
  archived: '已归档',
};

function cell(value: string | number | null | undefined): string {
  return String(value ?? '—')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();
}

function table(headers: string[], rows: Array<Array<string | number | null>>): string[] {
  if (rows.length === 0) return ['（无）'];
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ];
}

export function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

const TOP = 10;

export function renderRetroMarkdown(input: {
  aggregates: RetroAggregates;
  suggestions: RetroSuggestions;
  generatedAt: Date;
  timeZone: string;
}): string {
  const { aggregates: a, suggestions } = input;
  const generated = new Intl.DateTimeFormat('zh-CN', {
    timeZone: input.timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(input.generatedAt);
  const lastDay = new Date(Date.parse(a.month.end) - 1).toISOString().slice(0, 10);
  const status = (value: string) => STATUS_COPY[value] ?? value;
  const requestsByStatus = Object.entries(a.requests.by_status)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${status(key)} ${count}`)
    .join('、');

  return [
    `# ${retroTitle(a.month.month)}`,
    '',
    `> 自动生成于 ${generated}（${input.timeZone}）· 统计区间 ${a.month.start.slice(0, 10)} 至 ${lastDay}（UTC）。` +
      '只含汇总数字，不含任何对话内容、成员姓名或私有文档标题。重新生成会更新本文（保留历史版本）。',
    '',
    '## 一、模块使用',
    '',
    '### 页面打开（按模块）',
    '',
    ...table(
      ['模块', '次数'],
      a.modules.page_opens.slice(0, TOP).map((row) => [row.key, row.count]),
    ),
    '',
    '### 工具调用（按工具）',
    '',
    ...table(
      ['工具', '次数'],
      a.modules.tool_calls.slice(0, TOP).map((row) => [row.key, row.count]),
    ),
    '',
    '### 按客户端',
    '',
    ...table(
      ['客户端', '页面打开', '工具调用'],
      a.modules.by_client.map((row) => [row.client, row.page_opens, row.tool_calls]),
    ),
    '',
    '## 二、成员的 Agent',
    '',
    `- 本月成员的 Agent 写入 ${a.agents.writes} 次，来自 ${a.agents.members} 位成员。`,
    `- 失败 ${a.agents.by_client.reduce((sum, row) => sum + row.failed, 0)} 次，结果未知 ${a.agents.by_client.reduce((sum, row) => sum + row.outcome_unknown, 0)} 次。`,
    '',
    ...table(
      ['客户端', '写入', '成功', '失败', '结果未知'],
      a.agents.by_client.map((row) => [row.client, row.writes, row.executed, row.failed, row.outcome_unknown]),
    ),
    '',
    '## 三、问题与需求',
    '',
    `### 踩坑（本月活跃 ${a.frictions.active} 条，其中新增 ${a.frictions.new} 条）`,
    '',
    '> 「活跃」= 首次出现在月底前、最近一次出现在月初后；累计次数是从首次出现起的总数，不是本月次数。',
    '',
    ...table(
      ['工具', '类型', '错误类别', '条数', '累计次数'],
      a.frictions.top.map((row) => [
        row.tool,
        FRICTION_KIND_COPY[row.kind] ?? row.kind,
        ERROR_CLASS_COPY[row.error_class],
        row.frictions,
        row.occurrences,
      ]),
    ),
    '',
    `### 功能需求（本月提交 ${a.requests.submitted} 条${requestsByStatus ? `：${requestsByStatus}` : ''}）`,
    '',
    ...table(
      ['标题', '状态', '优先级'],
      a.requests.top.map((row) => [row.title, status(row.status), row.priority]),
    ),
    '',
    '## 四、花费',
    '',
    `- 本月合计 ${usd(a.spend.total_usd_micros)}，${a.spend.calls} 次计价调用` +
      (a.spend.unpriced_calls > 0 ? `（其中 ${a.spend.unpriced_calls} 次未定价，按 0 计）。` : '。'),
    '',
    ...table(
      ['服务', '花费', '调用'],
      a.spend.by_service.map((row) => [row.key, usd(row.cost_usd_micros), row.calls]),
    ),
    '',
    ...table(
      ['客户端', '花费', '调用'],
      a.spend.by_client.map((row) => [row.key, usd(row.cost_usd_micros), row.calls]),
    ),
    '',
    '## 五、下月建议',
    '',
    suggestions.ok ? suggestions.text.trim() : `> ${SKIP_COPY[suggestions.reason]}`,
    '',
  ].join('\n');
}
