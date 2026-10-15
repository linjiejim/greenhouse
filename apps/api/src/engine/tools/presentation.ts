import type { ToolDef } from './define.js';

type Locale = 'zh' | 'en';

/** Never stringify an object into member-facing copy. Keep nesting and lists readable. */
export function detailText(value: unknown, locale: Locale = 'en', depth = 0): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return locale === 'zh' ? (value ? '是' : '否') : value ? 'Yes' : 'No';
  if (typeof value !== 'object') return String(value);
  if (depth >= 5) return '…';
  if (Array.isArray(value))
    return (
      value
        .slice(0, 50)
        .map((item) => detailText(item, locale, depth + 1))
        .join(' · ') || '—'
    );
  return Object.entries(value)
    .slice(0, 50)
    .map(([key, item]) => `${detailLabel(key, locale)}：${detailText(item, locale, depth + 1)}`)
    .join('\n');
}

const labels: Record<string, [string, string]> = {
  action: ['操作', 'Action'],
  name: ['名称', 'Name'],
  title: ['标题', 'Title'],
  body: ['正文', 'Body'],
  content: ['内容', 'Content'],
  values: ['字段值', 'Values'],
  input: ['改动', 'Changes'],
  table_id: ['数据表', 'Table'],
  base_id: ['表格', 'Base'],
  record_id: ['记录', 'Record'],
  doc_id: ['文档', 'Doc'],
  folder_id: ['文件夹', 'Folder'],
  field_id: ['字段', 'Field'],
  type: ['类型', 'Type'],
  required: ['必填', 'Required'],
  config: ['设置', 'Settings'],
  options: ['选项', 'Options'],
  label: ['名称', 'Label'],
  schema_revision: ['结构版本', 'Schema revision'],
  revision: ['版本', 'Revision'],
  position: ['位置', 'Position'],
  to: ['收件人', 'To'],
  subject: ['主题', 'Subject'],
  url: ['网址', 'URL'],
  text: ['文字', 'Text'],
  query: ['查询', 'Query'],
  items: ['记录', 'Records'],
  primary: ['主字段', 'Primary field'],
  brief: ['简报', 'Brief'],
  cron: ['执行时间', 'Timing'],
  timezone: ['时区', 'Time zone'],
  quiet: ['无发现时不通知', 'Quiet when no findings'],
  computer: ['使用电脑', 'Use computer'],
  domains: ['可访问域名', 'Allowed domains'],
  continue_after: ['完成后继续', 'Continue after completion'],
};
export const detailLabel = (key: string, locale: Locale) =>
  labels[key]?.[locale === 'zh' ? 0 : 1] ?? key.replaceAll('_', ' ');

export function argumentDetails(args: unknown, locale: Locale = 'en') {
  if (!args || typeof args !== 'object') return [];
  const entries = Object.entries(args).filter(([, value]) => value !== undefined);
  const rows = entries.slice(0, 12).map(([key, value]) => {
    const text = detailText(value, locale);
    return { label: detailLabel(key, locale), value: text.length > 1200 ? `${text.slice(0, 1200)}…` : text };
  });
  if (entries.length > 12)
    rows.push({
      label: '…',
      value: locale === 'zh' ? `另有 ${entries.length - 12} 项` : `${entries.length - 12} more fields`,
    });
  return rows;
}

export function approvalStep(summary: string, state: string, locale: Locale): string {
  if (locale === 'zh') {
    if (state === 'pending') return `请求 ${summary} · 等你批准`;
    if (state === 'running') return `正在执行：${summary}`;
    if (state === 'uncertain') return `结果未知：${summary}`;
    if (state === 'succeeded') return `已完成：${summary}`;
    if (state === 'failed') return `未完成：${summary}`;
    return `未执行：${summary} · ${state === 'rejected' ? '已拒绝' : '已结束'}`;
  }
  if (state === 'pending') return `Requested: ${summary} · Awaiting your approval`;
  if (state === 'running') return `Performing: ${summary}`;
  if (state === 'succeeded') return `Completed: ${summary}`;
  return `${state === 'uncertain' ? 'Outcome unknown' : 'Not completed'}: ${summary}${state === 'rejected' ? ' · Declined' : ''}`;
}

/** The same state-aware wording in streamed steps, saved replies and run details. */
export function toolSummary(
  call: { tool: string; input: unknown; output?: unknown; status: string },
  defs: Map<string, ToolDef>,
  locale: Locale,
): string {
  const output = call.output as { status?: string; summary?: string; error?: unknown; code?: string } | undefined;
  if (output?.status === 'needs_approval')
    return approvalStep(output.summary ?? (locale === 'zh' ? '执行操作' : 'perform action'), 'pending', locale);
  if (call.status === 'running') return locale === 'zh' ? '正在处理' : 'Working';
  if (call.status === 'uncertain') return locale === 'zh' ? '操作结果未知' : 'Action outcome unknown';
  if (call.status === 'failed' || call.status === 'skipped' || output?.error || output?.code)
    return locale === 'zh' ? '操作未完成' : 'Action not completed';
  try {
    return (
      defs.get(call.tool)?.summarize?.(call.input, call.output, locale) ??
      (locale === 'zh' ? '完成了操作' : 'Completed an action')
    );
  } catch {
    return locale === 'zh' ? '完成了操作' : 'Completed an action';
  }
}
