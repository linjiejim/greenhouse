import { han, interpolate } from '@greenhouse/utils/i18n';
import { ProviderRequestError } from '@greenhouse/providers';
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
  agent_id: ['Agent', 'Agent'],
  instructions: ['指令', 'Instructions'],
  reason: ['原因', 'Reason'],
  due_at: ['提醒时间', 'Reminder time'],
  format: ['文件格式', 'File format'],
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
      value: locale === 'zh' ? han`另有 ${entries.length - 12} 项` : `${entries.length - 12} more fields`,
    });
  return rows;
}

export function approvalStep(summary: string, state: string, locale: Locale): string {
  if (locale === 'zh') {
    if (state === 'pending') return interpolate('zh', '请求 {summary} · 等你批准', { summary });
    if (state === 'running') return han`正在执行：${summary}`;
    if (state === 'uncertain') return han`结果未知：${summary}`;
    if (state === 'succeeded') return han`已完成：${summary}`;
    if (state === 'failed') return han`未完成：${summary}`;
    return han`未执行：${summary} · ${state === 'rejected' ? '已拒绝' : '已结束'}`;
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
    background_private_outbound: [
      '本次任务已读取私有数据，不能再向外部发送新参数；请在报告中说明尚未完成的工作',
      'This run has read private data and cannot send new arguments outside; report the work that remains',
    ],
    connector_read_plan_required: [
      '本次任务已读取私有数据，这组读取参数未提前声明；请说明缺少的结果，并请成员用明确参数开启新任务',
      'This run has read private data and these exact read arguments were not prepared; report the missing result and ask the member to start a new task with explicit arguments',
    ],
    connector_read_plan_locked: [
      '读取计划已固定，或本次任务已读取来源内容；请在新任务首次读取时一次声明全部已知参数',
      'The read plan is already fixed or this run has read source content; start a new task and prepare all known arguments on its first read',
    ],
    connector_read_plan_limit: [
      '读取计划最多包含 16 次后续读取，当前与后续参数合计不能超过 8192 字节；请缩小任务',
      'Prepare at most 16 further reads and 8192 bytes of current and future arguments; reduce the task size',
    ],
    connector_read_limit: [
      '本次运行读取数已达上限，请缩小范围并开启新任务',
      'This run reached its connector read limit; reduce the scope and start a new task',
    ],
    connector_read_scope_changed: [
      '连接账号、凭据或读取权限已更新，原计划和结果不能继续复用；请用当前连接开启新任务',
      'The connection account, credentials or read permissions changed; start a new task with the current connection instead of reusing this plan or result',
    ],
    connector_read_only_unverified: [
      '读取计划中的操作尚未经管理员确认为只读；请管理员在设置中的连接器页面核实后，再开启新任务',
      'An admin has not vouched for every planned action as read-only; ask an admin to verify them in Settings → Connectors before starting a new task',
    ],
    connector_read_plan_background_only: [
      '提前声明读取参数仅适用于已批准的后台任务',
      'Preparing future reads is available only in an approved background task',
    ],
    connector_connection_unavailable: [
      '当前连接凭据不可用，请重新连接后开启新任务',
      'The current connection credentials are unavailable; reconnect and start a new task',
    ],
    connector_key_unreadable: [
      '连接器密钥不可读取，请管理员重新设置密钥后再开启新任务',
      'The connector key cannot be read; ask an admin to set it again and start a new task',
    ],
    connector_background_read_only: [
      '后台任务只能执行连接器的只读操作，不能执行这次写入',
      'Background tasks can only use read-only connector actions and cannot perform this write',
    ],
    member_inactive: ['当前成员已停用，不能继续操作', 'The current member is inactive and cannot continue'],
    helper_read_only: [
      '辅助任务只能读取，不能执行这次写入',
      'Helper tasks are read-only and cannot perform this write',
    ],
    agent_write_disabled: ['此 Agent 未开启写入权限', 'Writing is disabled for this Agent'],
    connector_permission_denied: [
      '外部服务拒绝了这项操作，请检查连接权限',
      'The external service refused this action; check connection permissions',
    ],
    connector_item_missing: [
      '外部对象不存在，请检查对象或地址',
      'The external item was not found; check the item or address',
    ],
    connector_rate_limited: [
      '外部连接请求过于频繁，请稍后重试',
      'The external connection was rate limited; try again later',
    ],
    connector_timeout: ['外部连接响应超时，请稍后重试', 'The external connection timed out; try again later'],
    connector_action_failed: [
      '外部连接报告操作失败，请检查输入或重新连接',
      'The external connection reported an action failure; check the input or reconnect',
    ],
    operation_disabled: ['管理员已临时暂停此操作，请稍后再试', 'An admin paused this operation; try again later'],
    budget_exceeded: ['剩余预算不足', 'There is not enough remaining budget'],
    budget_estimate_unavailable: ['模型尚未设置价格，无法核对预算', 'Model prices are required to check the budget'],
    memory_background_read_only: [
      '后台运行只能读取记忆，不能修改；请勿重试这次写入',
      'Background runs can only read memories, not change them. Do not retry this write',
    ],
    memory_untrusted_content: [
      '本轮已读取网页等外部内容，不能直接存为或修改记忆；请勿重试，请成员在新一轮对话中确认',
      'This turn has read outside content, so memories cannot be changed. Do not retry; ask the member in a new turn',
    ],
    knowledge_content_limit: [
      '修改后的文档超过长度上限，请缩短改动或拆成多篇文档',
      'The edited doc would be over the limit; reduce the change or split it into multiple docs',
    ],
    knowledge_edit_not_found: [
      '未找到要替换的文字，请重新读取文档并使用其中的原文',
      'The text to replace was not found; read the current doc and use its exact text',
    ],
    knowledge_edit_ambiguous: [
      '要替换的文字出现多次，请补充前后文以便唯一匹配',
      'The text to replace appears more than once; include more surrounding text so it matches only once',
    ],
    knowledge_edit_empty: ['请提供新内容、精确替换或新标题', 'Provide new content, exact replacements or a new title'],
    source_base_only: ['这次运行只能读取来源表格', 'This run can only read its source base'],
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
        ? han`字段「${details.field_name}」${expected}`
        : `Field “${details.field_name}” ${expected}`
      : (codeReason ?? failureReason(error, def.name, ctx.locale));
  return interpolate(ctx.locale, zh ? '{action}失败：{reason}' : '{action} failed: {reason}', { action, reason });
}

/** Classify causes; unexpected exception text and vendor payloads never become UI copy. */
export function failureReason(error: unknown, tool: string, locale: Locale): string {
  const zh = locale === 'zh';
  const say = (cn: string, en: string) => (zh ? cn : en);
  const code = error instanceof ApiError ? error.code : '';
  const mapped: Record<string, [string, string]> = {
    provider_unavailable: [
      '服务不可用，请联系管理员检查配置',
      'The service is unavailable; ask an admin to check its configuration',
    ],
    llm_not_configured: ['尚未配置模型服务，请联系管理员', 'No model service is configured; contact an admin'],
    search_not_configured: ['尚未配置搜索服务，请联系管理员', 'No search service is configured; contact an admin'],
    web_address_blocked: [
      '此网址指向受限网络，请使用公开网页',
      'This address points to a restricted network; use a public page',
    ],
    web_invalid_type: [
      '此网址不是可阅读的网页，请使用网页链接',
      'This address is not a readable web page; use a page link',
    ],
    web_redirect_limit: [
      '网站重定向次数过多，请使用最终网页链接',
      'The site redirected too many times; use the final page link',
    ],
    web_page_too_large: ['网页内容太长，请换一个较短的页面', 'The page is too large; use a shorter page'],
    file_too_large: ['文件内容太长，请缩小后再试', 'The file is too large; reduce it before trying again'],
    file_limit: [
      '本轮生成文件已达上限，请在新一轮继续',
      'This turn has reached the file limit; continue in a new turn',
    ],
    private_conversation_required: ['请在自己的私有对话中操作', 'Use your own private conversation for this action'],
    agent_self_proposal_required: [
      '修改当前 Agent 的指令需要成员批准',
      'Changing this Agent’s instructions requires the member’s approval',
    ],
  };
  if (mapped[code]) return mapped[code][zh ? 0 : 1];
  const provider = error instanceof ProviderRequestError;
  // Page readers can report the origin HTTP status separately from their own service status.
  const pageStatus = provider && /page: it answered HTTP (\d{3})/i.exec(error.message);
  if (
    provider &&
    tool === 'web_fetch' &&
    (error.statusCode === undefined || error.statusCode >= 500) &&
    /\b403\b|forbidden|blocked|access denied/i.test(error.message)
  )
    return say('网站拒绝访问，请换一个公开来源', 'The site refused access; try another public source');
  if (provider && /timed? out|timeout/i.test(error.message))
    return say('等待响应超时，请稍后重试或换一个来源', 'The request timed out; try again later or use another source');
  if (provider && /too (?:large|long)|size limit/i.test(error.message))
    return say('内容太长，请缩小范围后重试', 'The content is too large; narrow the request and try again');
  const pageHttpStatus =
    error instanceof ApiError && error.code === 'web_page_refused'
      ? (error.details as { http_status?: number } | undefined)?.http_status
      : undefined;
  const status =
    pageHttpStatus ??
    (pageStatus
      ? Number(pageStatus[1])
      : error instanceof ApiError
        ? error.status
        : provider
          ? error.statusCode
          : undefined);
  if (status === 401 || status === 403)
    return tool === 'web_fetch' && (pageStatus || !provider)
      ? say('网站拒绝访问，请换一个公开来源', 'The site refused access; try another public source')
      : say(
          '服务拒绝访问，请检查连接权限或联系管理员',
          'The service refused access; check connection permissions or contact an admin',
        );
  if (status === 404 || status === 410)
    return say(
      '页面或对象不存在，请检查地址或换一个来源',
      'The page or item was not found; check the address or use another source',
    );
  if (
    status === 408 ||
    status === 504 ||
    (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
  )
    return say('等待响应超时，请稍后重试或换一个来源', 'The request timed out; try again later or use another source');
  if (status === 413)
    return say('内容太长，请缩小范围后重试', 'The content is too large; narrow the request and try again');
  if (status === 429)
    return say(
      '请求过于频繁或额度已用完，请稍后重试或联系管理员',
      'The request was rate limited or quota was exhausted; try later or contact an admin',
    );
  if (status === 402) return say('服务额度不足，请联系管理员', 'The service is out of credit; contact an admin');
  if (provider && error.code && /^(?:EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT)$/.test(error.code))
    return error.code === 'ETIMEDOUT'
      ? say('连接超时，请稍后重试', 'The connection timed out; try again later')
      : say(
          '无法连接到网站或服务，请检查地址或稍后重试',
          'The site or service could not be reached; check the address or try later',
        );
  if (
    error instanceof Error &&
    /(?:private (?:network|addresses)|resolves only to private|endpoint.*(?:blocked|not allowed))/i.test(error.message)
  )
    return say('此网址指向受限网络，请使用公开网页', 'This address points to a restricted network; use a public page');
  if (status && status >= 500)
    return say(
      '服务暂时不可用，请稍后重试或换一个来源',
      'The service is temporarily unavailable; try later or use another source',
    );
  return say(
    '操作没有完成，请检查输入和访问权限后重试',
    'The action was not completed; check the input and access permissions before retrying',
  );
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
