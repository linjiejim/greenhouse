import { ApiError } from '../../http/errors.js';
import type { ToolCallRecord } from '@greenhouse/agent-core';
import type { ToolContext, ToolDef } from './define.js';

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
  call: { tool: string; input: unknown; output?: unknown; error?: string | { message: string } | null; status: string },
  defs: Map<string, ToolDef>,
  locale: Locale,
): string {
  const output = call.output as { status?: string; summary?: string; error?: unknown; code?: string } | undefined;
  if (output?.status === 'needs_approval')
    return approvalStep(output.summary ?? (locale === 'zh' ? '执行操作' : 'perform action'), 'pending', locale);
  if (call.status === 'running') return locale === 'zh' ? '正在处理' : 'Working';
  if (call.status === 'uncertain') return locale === 'zh' ? '操作结果未知' : 'Action outcome unknown';
  if (call.status === 'failed' || call.status === 'skipped' || output?.error || output?.code) {
    const error = typeof call.error === 'string' ? call.error : call.error?.message;
    if (error && (locale === 'zh' ? error.includes('失败：') : error.includes(' failed: '))) return error;
    const def = defs.get(call.tool);
    return def
      ? failureSummary(
          def,
          call.input,
          new ApiError(
            502,
            typeof call.error === 'object' && call.error && 'code' in call.error
              ? String(call.error.code)
              : 'tool_failed',
            '',
          ),
          { locale, conversation: null },
        )
      : locale === 'zh'
        ? '操作未完成：请检查输入和访问权限'
        : 'Action not completed: check inputs and access';
  }

  try {
    return (
      defs.get(call.tool)?.summarize?.(call.input, call.output, locale) ??
      (locale === 'zh' ? '完成了操作' : 'Completed an action')
    );
  } catch {
    return locale === 'zh' ? '完成了操作' : 'Completed an action';
  }
}

/** Companion labels for machine enums in tool evidence. Never apply this to record values. */
export function spaceLabel(space: string, locale: Locale): string {
  const names: Record<string, [string, string]> = {
    personal: ['个人知识库', 'Personal knowledge'],
    team: ['团队知识库', 'Team knowledge'],
    shared: ['共享知识库', 'Shared knowledge'],
    agent: ['Agent 参考资料', 'Agent reference material'],
  };
  return names[space]?.[locale === 'zh' ? 0 : 1] ?? (locale === 'zh' ? '知识库' : 'Knowledge');
}
export function accessLabel(access: string, locale: Locale): string {
  const names: Record<string, [string, string]> = {
    owner: ['所有者', 'Owner'],
    builder: ['可搭建', 'Can build'],
    editor: ['可编辑', 'Can edit'],
    viewer: ['可查看', 'Can view'],
    edit: ['可编辑', 'Can edit'],
    read: ['可查看', 'Can view'],
  };
  return names[access]?.[locale === 'zh' ? 0 : 1] ?? (locale === 'zh' ? '按现有权限访问' : 'Existing access');
}

/** Human action and cause, used both in the model result and persisted step evidence. */
export function failureSummary(
  def: ToolDef,
  input: unknown,
  error: unknown,
  ctx: Pick<ToolContext, 'locale' | 'conversation'>,
): string {
  const zh = ctx.locale === 'zh';
  let action = zh ? '操作' : 'Action';
  try {
    action = def.summarize?.(input, undefined, ctx.locale) ?? action;
  } catch {
    /* A result may be required. */
  }
  if (zh) action = action.replace('了', '');
  const details =
    error instanceof ApiError ? (error.details as { field_name?: string; expected?: string } | undefined) : undefined;
  const reasons: Record<string, [string, string]> = {
    'one of its options': ['没有这个选项', 'does not have this option'],
    'some of its options': ['包含不存在的选项', 'contains unknown options'],
    'a number': ['需要填写数字', 'requires a number'],
    'an email address': ['需要有效的邮箱地址', 'requires a valid email address'],
    'a phone number': ['需要有效的电话号码', 'requires a valid phone number'],
    'a date (YYYY-MM-DD)': ['需要有效的日期', 'requires a valid date'],
    'a date and time (ISO 8601)': ['需要有效的日期和时间', 'requires a valid date and time'],
    'a web address starting with http:// or https://': [
      '需要以 http:// 或 https:// 开头的网址',
      'requires an http:// or https:// URL',
    ],
    'true or false': ['需要勾选或取消勾选', 'requires a checkbox value'],
  };
  const expected = details?.expected && reasons[details.expected]?.[zh ? 0 : 1];
  const codes: Record<string, [string, string]> = {
    forbidden: ['没有操作权限', 'You do not have permission'],
    not_found: ['对象不存在或无法访问', 'Item is missing or inaccessible'],
    invalid_input: ['输入内容不符合要求', 'Check the supplied values'],
    stale_revision: ['内容已被修改，请刷新后重试', 'The content changed; refresh before trying again'],
    stale_version: ['内容已被修改，请重新读取', 'The content changed; read it again'],
  };
  const codeReason = error instanceof ApiError ? codes[error.code]?.[zh ? 0 : 1] : undefined;
  const reason =
    details?.field_name && expected && ctx.conversation?.kind !== 'room'
      ? zh
        ? `字段「${details.field_name}」${expected}`
        : `Field “${details.field_name}” ${expected}`
      : (codeReason ??
        (zh ? '服务未能完成这次操作，请稍后重试' : 'The service could not complete this action; try again later'));
  return zh ? `${action}失败：${reason}` : `${action} failed: ${reason}`;
}

/** A later successful attempt must address the same action and object to recover a failed step. */
export function recoveredCalls(
  calls: ToolCallRecord[],
  identities = new Map<ToolCallRecord, string>(),
): Set<ToolCallRecord> {
  const target = (call: ToolCallRecord) => {
    if (identities.has(call)) return identities.get(call);
    const input = call.input as Record<string, unknown> | null;
    return JSON.stringify(
      ['action', 'table_id', 'record_id', 'base_id', 'doc_id', 'folder_id', 'app_id', 'skill', 'url', 'query'].map(
        (key) => input?.[key] ?? null,
      ),
    );
  };
  const success = (call: ToolCallRecord) => {
    const output = call.output as { error?: unknown; code?: unknown; status?: string } | undefined;
    return (
      call.status === 'done' &&
      !output?.error &&
      !output?.code &&
      !['needs_approval', 'uncertain', 'failed'].includes(output?.status ?? '')
    );
  };
  return new Set(
    calls.filter(
      (call, index) =>
        call.status === 'failed' &&
        calls
          .slice(index + 1)
          .some((later) => later.tool === call.tool && target(later) === target(call) && success(later)),
    ),
  );
}
