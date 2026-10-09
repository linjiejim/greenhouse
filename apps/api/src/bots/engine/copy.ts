/**
 * Bots — server-written copy (system events, cards, notifications, speaker tags).
 *
 * Every line the engine itself writes into a transcript or a notification goes
 * through here, in the conversation owner's UI locale (`users.locale`). Two
 * reasons it is one module rather than inline strings:
 * - the speaker tags (`[小研（Bot）]:`) are a protocol, not decoration: the
 *   projection writes them, the static rules (S1) describe them, and Bot names
 *   are validated against them — all three must agree byte for byte;
 * - system events are persisted verbatim, so a wording change here is a change
 *   to what every later turn of every Bot reads back.
 */

import type { BotEvent, BotRequestKind } from '@greenhouse/types/bots';

export type BotsLocale = 'en' | 'zh';

export function botsLocale(raw: string | null | undefined): BotsLocale {
  return raw === 'zh' ? 'zh' : 'en';
}

// ─── Speaker tags (projection protocol) ──────────────────

/** Strip the characters that would let a nickname break out of a tag. */
function tagSafe(name: string): string {
  return name.replace(/[[\]:：\r\n]/g, '').trim() || '?';
}

export interface SpeakerTags {
  user(nickname: string): string;
  bot(name: string): string;
  event: string;
  task(name: string): string;
  deleted: string;
}

export const SPEAKER_TAGS: Record<BotsLocale, SpeakerTags> = {
  zh: {
    user: (nickname) => `[${tagSafe(nickname)}（用户）]:`,
    bot: (name) => `[${tagSafe(name)}（Bot）]:`,
    event: '[事件]:',
    task: (name) => `[后台任务·${tagSafe(name)}]:`,
    deleted: '[已删除的 Bot]:',
  },
  en: {
    user: (nickname) => `[${tagSafe(nickname)} (user)]:`,
    bot: (name) => `[${tagSafe(name)} (Bot)]:`,
    event: '[Event]:',
    task: (name) => `[Background task · ${tagSafe(name)}]:`,
    deleted: '[Deleted Bot]:',
  },
};

// ─── System events ───────────────────────────────────────

const LIMIT_REASON: Record<BotsLocale, Record<Extract<BotEvent, { kind: 'limit' }>['reason'], string>> = {
  zh: {
    turns: 'Bot 发言轮数',
    asks: '交接次数',
    depth: '交接层数',
    tokens: '本轮 token 用量',
    steps: '本轮步数',
    wall_clock: '本轮时长',
  },
  en: {
    turns: 'number of Bot turns',
    asks: 'number of hand-offs',
    depth: 'hand-off depth',
    tokens: 'token budget',
    steps: 'step budget',
    wall_clock: 'time limit',
  },
};

// ─── Approval cards ──────────────────────────────────────

/**
 * What an approval-gated Greenhouse writer (`BOT_APPROVAL_TOOL_IDS`) is about to
 * do, as a verb phrase in the member's locale. The tool catalog's `name` is an
 * untranslated developer label ("Knowledge Mutation"), so it is only the
 * fallback for a writer missing here (an extension's `surface.proxy:'write'`
 * tool). `email_mutation` names the step: a draft sends nothing.
 */
const TOOL_ACTIONS: Record<string, Record<BotsLocale, string>> = {
  knowledge_mutation: { zh: '修改知识库', en: 'edit the knowledge base' },
  tables_mutation: { zh: '修改数据表记录', en: 'edit Tables records' },
  project_mutation: { zh: '修改项目和任务', en: 'edit projects and tasks' },
  workbench_mutation: { zh: '修改首页工作台', en: 'edit your home workbench' },
  skill_mutation: { zh: '修改技能中心', en: 'change the Skill Center' },
  automation_mutation: { zh: '修改自动化任务', en: 'change your automations' },
  email_mutation: { zh: '起草或发送邮件', en: 'draft or send an email' },
  feature_request: { zh: '提交或修改功能建议', en: 'file or update a feature request' },
};

const EMAIL_ACTIONS: Record<string, Record<BotsLocale, string>> = {
  draft: { zh: '起草邮件', en: 'draft an email' },
  send: { zh: '发送邮件', en: 'send an email' },
};

/** The localized verb phrase for a gated tool call, or null when the tool has none. */
export function toolAction(l: BotsLocale, toolId: string, input?: unknown): string | null {
  if (toolId === 'email_mutation' && input && typeof input === 'object') {
    const step = (input as Record<string, unknown>).action;
    if (typeof step === 'string' && Object.hasOwn(EMAIL_ACTIONS, step)) return EMAIL_ACTIONS[step][l];
  }
  return Object.hasOwn(TOOL_ACTIONS, toolId) ? TOOL_ACTIONS[toolId][l] : null;
}

/** `toolAction`, or "use «catalog name»" for a writer without a phrase. */
export function toolActionPhrase(l: BotsLocale, tool: { id: string; name: string; input?: unknown }): string {
  return toolAction(l, tool.id, tool.input) ?? (l === 'zh' ? `使用「${tool.name}」` : `use ${tool.name}`);
}

/**
 * Labels for the argument rows of a tool-call approval card: the call's own
 * keys in the member's words (their values: `approvalFieldValue`). A key
 * missing here is shown humanized (`content_json` → "Content json").
 */
const FIELD_LABELS: Record<string, Record<BotsLocale, string>> = {
  action: { zh: '操作', en: 'Action' },
  // Knowledge
  scope: { zh: '范围', en: 'Scope' },
  doc_id: { zh: '文档 ID', en: 'Document ID' },
  title: { zh: '标题', en: 'Title' },
  content: { zh: '内容', en: 'Content' },
  content_json: { zh: '内容（编辑器格式）', en: 'Content (editor format)' },
  find: { zh: '查找', en: 'Find' },
  replace: { zh: '替换为', en: 'Replace with' },
  heading: { zh: '章节', en: 'Section' },
  folder: { zh: '文件夹', en: 'Folder' },
  tags: { zh: '标签', en: 'Tags' },
  summary: { zh: '摘要', en: 'Summary' },
  version: { zh: '版本', en: 'Version' },
  share_role: { zh: '共享权限', en: 'Share role' },
  share_targets: { zh: '共享给', en: 'Share with' },
  change_reason: { zh: '修改原因', en: 'Reason for change' },
  meta: { zh: '元数据', en: 'Metadata' },
  // Tables
  table_id: { zh: '数据表 ID', en: 'Table ID' },
  record_id: { zh: '记录 ID', en: 'Record ID' },
  values: { zh: '字段值', en: 'Values' },
  items: { zh: '批量记录', en: 'Records' },
  // Projects
  project_id: { zh: '项目 ID', en: 'Project ID' },
  task_id: { zh: '任务 ID', en: 'Task ID' },
  description: { zh: '描述', en: 'Description' },
  status: { zh: '状态', en: 'Status' },
  priority: { zh: '优先级', en: 'Priority' },
  owner_id: { zh: '负责人', en: 'Owner' },
  assignee_id: { zh: '指派给', en: 'Assignee' },
  visibility: { zh: '可见范围', en: 'Visibility' },
  parent_id: { zh: '上级任务', en: 'Parent task' },
  start_date: { zh: '开始日期', en: 'Start date' },
  end_date: { zh: '结束日期', en: 'End date' },
  due_date: { zh: '截止日期', en: 'Due date' },
  estimated_hours: { zh: '预估工时', en: 'Estimated hours' },
  // Automations, feature requests, skills
  id: { zh: 'ID', en: 'ID' },
  name: { zh: '名称', en: 'Name' },
  task_prompt: { zh: '任务指令', en: 'Task prompt' },
  schedule: { zh: '执行计划', en: 'Schedule' },
  timezone: { zh: '时区', en: 'Time zone' },
  profile_id: { zh: 'Agent', en: 'Agent' },
  max_steps: { zh: '最大步数', en: 'Max steps' },
  enabled: { zh: '启用', en: 'Enabled' },
  notify_webhook: { zh: '群机器人 Webhook', en: 'Group webhook' },
  notify_email: { zh: '邮件通知', en: 'Email summary' },
  new_status: { zh: '新状态', en: 'New status' },
  new_priority: { zh: '新优先级', en: 'New priority' },
  admin_note: { zh: '管理员备注', en: 'Admin note' },
  limit: { zh: '数量上限', en: 'Limit' },
  offset: { zh: '偏移', en: 'Offset' },
  display_name: { zh: '显示名称', en: 'Display name' },
  changelog: { zh: '更新说明', en: 'Changelog' },
  files: { zh: '文件', en: 'Files' },
  // Workbench
  template_id: { zh: '模板', en: 'Template' },
  widget_id: { zh: '卡片 ID', en: 'Card ID' },
  tab_id: { zh: '标签页 ID', en: 'Tab ID' },
  recipe_id: { zh: '卡片配方', en: 'Recipe' },
  tool_id: { zh: '工具', en: 'Tool' },
  input: { zh: '查询参数', en: 'Query input' },
  display: { zh: '显示方式', en: 'Display' },
  chart_type: { zh: '图表类型', en: 'Chart type' },
  map: { zh: '字段映射', en: 'Field mapping' },
  markdown: { zh: 'Markdown', en: 'Markdown' },
  nav: { zh: '导航', en: 'Navigation' },
  size: { zh: '尺寸', en: 'Size' },
  // Email (the send card shows the stored draft — tools-assembly.ts approvalDetails)
  mailbox: { zh: '发件邮箱', en: 'Mailbox' },
  from: { zh: '发件人', en: 'From' },
  to: { zh: '收件人', en: 'To' },
  cc: { zh: '抄送', en: 'Cc' },
  bcc: { zh: '密送', en: 'Bcc' },
  subject: { zh: '主题', en: 'Subject' },
  body: { zh: '正文', en: 'Body' },
  attachments: { zh: '附件', en: 'Attachments' },
  attachment_ids: { zh: '附件', en: 'Attachments' },
  reply_to_uid: { zh: '回复的邮件', en: 'In reply to' },
  note: { zh: '说明', en: 'Note' },
  // External connectors (mcp_call)
  connector: { zh: '连接器', en: 'Connector' },
  remote_tool: { zh: '工具', en: 'Tool' },
};

/** An approval card's row label for one argument key. */
export function approvalFieldLabel(l: BotsLocale, key: string): string {
  if (Object.hasOwn(FIELD_LABELS, key)) return FIELD_LABELS[key][l];
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

type ValueWords = Record<string, Record<BotsLocale, string>>;

/** Project / task statuses (`project_mutation`) and feature-request statuses (`feature_request`). */
const STATUS_VALUES: ValueWords = {
  planning: { zh: '计划中', en: 'Planning' },
  active: { zh: '活跃', en: 'Active' },
  on_hold: { zh: '暂停', en: 'On hold' },
  completed: { zh: '已完成', en: 'Completed' },
  archived: { zh: '已归档', en: 'Archived' },
  todo: { zh: '待办', en: 'To do' },
  in_progress: { zh: '进行中', en: 'In progress' },
  in_review: { zh: '评审中', en: 'In review' },
  done: { zh: '已完成', en: 'Done' },
  cancelled: { zh: '已取消', en: 'Cancelled' },
  pending: { zh: '待处理', en: 'Pending' },
  accepted: { zh: '已采纳', en: 'Accepted' },
  rejected: { zh: '已拒绝', en: 'Rejected' },
};

const PRIORITY_VALUES: ValueWords = {
  low: { zh: '低', en: 'Low' },
  normal: { zh: '普通', en: 'Normal' },
  high: { zh: '高', en: 'High' },
  urgent: { zh: '紧急', en: 'Urgent' },
};

/**
 * Words for the enum VALUES of the built-in writers' arguments, per argument key
 * — from their schemas (`tools/*-mutation.ts`, `workbench.ts`, `feature-request.ts`;
 * `tool-faces.test.ts` checks every value is here). Display only: the call runs
 * with the raw value. A value missing here is shown as-is (ids, free text, an
 * extension tool's own enums). One table per key serves every tool, so a word
 * must stay true for any tool that uses the key.
 */
const FIELD_VALUES: Record<string, ValueWords> = {
  action: {
    // Knowledge
    'knowledge.create_doc': { zh: '新建文档', en: 'Create document' },
    'knowledge.update_doc': { zh: '更新文档', en: 'Update document' },
    'knowledge.patch_doc': { zh: '局部修改文档', en: 'Edit part of a document' },
    'knowledge.append_doc': { zh: '在文档末尾追加', en: 'Append to document' },
    'knowledge.update_section': { zh: '替换文档章节', en: 'Replace a document section' },
    'knowledge.archive_doc': { zh: '归档文档', en: 'Archive document' },
    'knowledge.restore_version': { zh: '恢复到历史版本', en: 'Restore an earlier version' },
    'knowledge.share_doc': { zh: '共享文档', en: 'Share document' },
    'knowledge.unshare_doc': { zh: '取消共享文档', en: 'Stop sharing document' },
    // Tables
    'records.create': { zh: '新建记录', en: 'Create record' },
    'records.update': { zh: '更新记录', en: 'Update record' },
    'records.upsert': { zh: '新建或更新记录', en: 'Create or update record' },
    'records.batch_upsert': { zh: '批量新建或更新记录', en: 'Create or update records in bulk' },
    'records.delete': { zh: '删除记录', en: 'Delete record' },
    // Projects
    'project.create': { zh: '新建项目', en: 'Create project' },
    'project.update': { zh: '更新项目', en: 'Update project' },
    'task.create': { zh: '新建任务', en: 'Create task' },
    'task.update': { zh: '更新任务', en: 'Update task' },
    'comment.add': { zh: '添加评论', en: 'Add comment' },
    // Home workbench
    apply_template: { zh: '套用模板', en: 'Apply template' },
    add_widget: { zh: '添加卡片', en: 'Add card' },
    update_widget: { zh: '更新卡片', en: 'Update card' },
    remove_widget: { zh: '移除卡片', en: 'Remove card' },
    add_tab: { zh: '添加标签页', en: 'Add tab' },
    rename_tab: { zh: '重命名标签页', en: 'Rename tab' },
    remove_tab: { zh: '移除标签页', en: 'Remove tab' },
    // Skill Center
    'skills.publish': { zh: '发布技能', en: 'Publish skill' },
    'skills.update_meta': { zh: '更新技能信息', en: 'Update skill details' },
    'skills.archive': { zh: '归档技能', en: 'Archive skill' },
    'skills.unarchive': { zh: '取消归档技能', en: 'Unarchive skill' },
    'skills.delete': { zh: '删除技能', en: 'Delete skill' },
    // Automations, email, feature requests (the card title already names the tool)
    create: { zh: '新建', en: 'Create' },
    update: { zh: '更新', en: 'Update' },
    delete: { zh: '删除', en: 'Delete' },
    run_now: { zh: '立即运行', en: 'Run now' },
    draft: { zh: '起草', en: 'Draft' },
    send: { zh: '发送', en: 'Send' },
    submit: { zh: '提交', en: 'Submit' },
    list: { zh: '查看列表', en: 'List' },
  },
  // Keyed by argument, not by tool, so an extension writer's `scope` reads them
  // too: say whose it is, not where it lives.
  scope: {
    team: { zh: '团队', en: 'Team' },
    personal: { zh: '个人', en: 'Personal' },
    bot: { zh: '本 Bot 私有', en: 'Private to this Bot' },
  },
  share_role: {
    reader: { zh: '只读', en: 'Read-only' },
    editor: { zh: '可编辑', en: 'Can edit' },
  },
  status: STATUS_VALUES,
  new_status: STATUS_VALUES,
  priority: PRIORITY_VALUES,
  new_priority: PRIORITY_VALUES,
  visibility: {
    public: { zh: '公开', en: 'Public' },
    private: { zh: '私有', en: 'Private' },
  },
  display: {
    kpi: { zh: 'KPI', en: 'KPI' },
    chart: { zh: '图表', en: 'Chart' },
    table: { zh: '表格', en: 'Table' },
    list: { zh: '列表', en: 'List' },
  },
  chart_type: {
    bar: { zh: '柱状图', en: 'Bar chart' },
    line: { zh: '折线图', en: 'Line chart' },
    pie: { zh: '饼图', en: 'Pie chart' },
    doughnut: { zh: '环形图', en: 'Doughnut chart' },
  },
};

const BOOLEAN_VALUES: Record<'true' | 'false', Record<BotsLocale, string>> = {
  true: { zh: '是', en: 'Yes' },
  false: { zh: '否', en: 'No' },
};

/**
 * An approval card's shown value for one scalar argument: a known enum value
 * of that key (`FIELD_VALUES`) or a boolean in the member's words, anything
 * else verbatim. Never feeds back into the call.
 */
export function approvalFieldValue(l: BotsLocale, key: string, value: string | number | boolean): string {
  if (typeof value === 'boolean') return BOOLEAN_VALUES[value ? 'true' : 'false'][l];
  if (typeof value === 'number') return String(value);
  const words = Object.hasOwn(FIELD_VALUES, key) ? FIELD_VALUES[key] : undefined;
  return words && Object.hasOwn(words, value) ? words[value][l] : value;
}

export const copy = {
  /**
   * The verb phrase of an approval card for a remote connector tool. The
   * connector name is the admin's; the tool name is the remote server's own
   * and shown verbatim (the card's rows carry the exact arguments).
   */
  mcpCallAction: (l: BotsLocale, connector: string, toolName: string) =>
    l === 'zh' ? `在「${connector}」上运行 ${toolName}` : `run ${toolName} on ${connector}`,

  mcpDestructiveNote: (l: BotsLocale) =>
    l === 'zh'
      ? '这个工具的服务器声明它可能删除或覆盖数据。'
      : 'The server says this tool may delete or overwrite data.',

  ask: (l: BotsLocale, from: string, to: string, message: string) =>
    l === 'zh' ? `${from} → @${to}：${message}` : `${from} → @${to}: ${message}`,

  limit: (l: BotsLocale, reason: Extract<BotEvent, { kind: 'limit' }>['reason']) =>
    l === 'zh'
      ? `协作已达上限（${LIMIT_REASON.zh[reason]}），先停在这里。`
      : `Collaboration limit reached (${LIMIT_REASON.en[reason]}) — stopped here.`,

  turnError: (l: BotsLocale, bot: string, reason: string) =>
    l === 'zh' ? `${bot} 没能回复（${reason}）` : `${bot} couldn't reply (${reason})`,

  created: (l: BotsLocale, name: string) => (l === 'zh' ? `新建了 Bot「${name}」` : `Created the Bot “${name}”`),

  joined: (l: BotsLocale, name: string, byBot?: string) =>
    l === 'zh'
      ? byBot
        ? `${byBot} 邀请了 ${name}`
        : `${name} 加入了对话`
      : byBot
        ? `${byBot} added ${name}`
        : `${name} joined`,

  left: (l: BotsLocale, name: string) => (l === 'zh' ? `${name} 离开了对话` : `${name} left the conversation`),

  taskStarted: (l: BotsLocale, bot: string, title: string) =>
    l === 'zh' ? `${bot} 开始后台任务「${title}」` : `${bot} started “${title}” in the background`,

  taskUnavailable: (l: BotsLocale, title: string) =>
    l === 'zh'
      ? `这个部署已关闭后台任务，「${title}」没有开始。`
      : `Background tasks are turned off on this deployment, so “${title}” was not started.`,

  taskFailedReport: (l: BotsLocale, title: string, reason: string) =>
    l === 'zh' ? `后台任务「${title}」没有完成：${reason}` : `The background task “${title}” did not finish: ${reason}`,

  taskCanceledReport: (l: BotsLocale, title: string) =>
    l === 'zh' ? `后台任务「${title}」已取消。` : `The background task “${title}” was canceled.`,

  taskInterrupted: (l: BotsLocale) =>
    l === 'zh'
      ? '服务器重启打断了任务；为避免重复操作没有自动重跑。需要的话让我再开始一次。'
      : 'A server restart interrupted it; it was not re-run automatically to avoid repeating work. Ask me to start it again if needed.',

  taskReportTruncated: (l: BotsLocale, link: string) =>
    l === 'zh' ? `\n\n…（汇报较长，[完整内容](${link})）` : `\n\n…(long report — [full text](${link}))`,

  digest: (l: BotsLocale) => (l === 'zh' ? '更早的内容已整理成摘要' : 'Earlier messages were summarised'),

  /** Persisted for a turn that ran tools but wrote no text, so its work stays visible. */
  handedOver: (l: BotsLocale, names: string[]) =>
    l === 'zh' ? `（已交给 ${names.join('、')}）` : `(Handed over to ${names.join(', ')}.)`,
  // A turn that ended on a card with nothing to say: point at the card (this
  // line is also the conversation's preview in the sidebar).
  waitingForMember: (l: BotsLocale) =>
    l === 'zh' ? '轮到你了：请看上面的卡片。' : 'Over to you — see the card above.',
  workedWithoutText: (l: BotsLocale) => (l === 'zh' ? '（已完成上面的步骤）' : '(Done — see the steps above.)'),

  limitInterruption: (l: BotsLocale) =>
    l === 'zh' ? '已达到本轮协作上限，回复在这里中断。' : 'The collaboration limit for this round was reached here.',

  requestEvent: (l: BotsLocale, bot: string, kind: BotRequestKind, subject: string) => {
    const zh: Record<BotRequestKind, string> = {
      approval: `${bot} 请你批准：${subject}`,
      login: `${bot} 需要你登录${subject ? ` ${subject}` : ''}`,
      takeover: `${bot} 请你接管电脑：${subject}`,
      bot_create: `${bot} 提议新建 Bot「${subject}」`,
      task_start: `${bot} 提议后台任务「${subject}」`,
      instructions_update: `${bot} 提议修改自己的守则：${subject}`,
    };
    const en: Record<BotRequestKind, string> = {
      approval: `${bot} asks you to approve: ${subject}`,
      login: `${bot} needs you to sign in${subject ? ` to ${subject}` : ''}`,
      takeover: `${bot} asks you to take over the computer: ${subject}`,
      bot_create: `${bot} proposes a new Bot “${subject}”`,
      task_start: `${bot} proposes the background task “${subject}”`,
      instructions_update: `${bot} proposes a change to its own instructions: ${subject}`,
    };
    return (l === 'zh' ? zh : en)[kind];
  },

  /**
   * An implicit take-over (no card the Bot asked for): the member took the
   * screen while the Bot was acting, or the Bot found it in their hands. The
   * hand-back wakes the Bot, so the line says it will carry on.
   */
  implicitTakeover: (l: BotsLocale, bot: string, reason: 'interrupted' | 'waiting', host: string) => {
    const where = host ? (l === 'zh' ? `（${host}）` : ` (${host})`) : '';
    if (l === 'zh') {
      return reason === 'interrupted'
        ? `你接管了电脑，${bot} 的操作已暂停${where}——用完交还，它会接着做`
        : `${bot} 在等你交还电脑${where}——用完交还，它会接着做`;
    }
    return reason === 'interrupted'
      ? `You took over the computer and paused ${bot}${where} — hand it back when you're done and it will carry on`
      : `${bot} is waiting for the computer${where} — hand it back when you're done and it will carry on`;
  },

  /**
   * The reason on a verification card the browser raised when a site asked
   * for human verification: the host only (server-derived), never page content.
   */
  humanCheckReason: (l: BotsLocale, host: string | null) =>
    l === 'zh'
      ? `${host ?? '这个网站'} 要求人机验证，请在电脑上完成验证`
      : `${host ?? 'This site'} asks for human verification — please complete it on the computer`,

  /** A turn the member interrupted ("stop after this step") before it wrote anything. */
  interruptedWithoutText: (l: BotsLocale) =>
    l === 'zh' ? '（在这一步之后停下了，见上面的步骤）' : '(Stopped after this step — see the steps above.)',

  declined: (l: BotsLocale, kind: BotRequestKind, subject: string) => {
    if (kind === 'bot_create') return l === 'zh' ? `你没有新建「${subject}」` : `You declined to create “${subject}”`;
    if (kind === 'task_start')
      return l === 'zh' ? `你没有开始后台任务「${subject}」` : `You declined the background task “${subject}”`;
    if (kind === 'instructions_update')
      return l === 'zh' ? `你没有采纳守则修改：${subject}` : `You declined the instructions change: ${subject}`;
    return l === 'zh' ? `你拒绝了：${subject}` : `You declined: ${subject}`;
  },

  /** The member accepted a Bot's proposed instructions (now version N). */
  instructionsUpdated: (l: BotsLocale, bot: string, version: number) =>
    l === 'zh' ? `${bot} 的守则已更新（v${version}）` : `${bot}'s instructions were updated (v${version})`,

  /**
   * An approval card's title from its verb phrase (`toolActionPhrase`): the question alone —
   * every client's card header already names the Bot ("Sage needs your approval").
   */
  approvalTitle: (l: BotsLocale, phrase: string) =>
    l === 'zh' ? `${phrase}？` : `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}?`,

  /** The transcript line / notification title of an approval card: the Bot named once. */
  approvalLine: (l: BotsLocale, bot: string, phrase: string) =>
    l === 'zh' ? `${bot} 请你批准：${phrase}` : `${bot} asks to ${phrase}`,

  /** Server-written values on an email send card. */
  emailCard: {
    noDraft: (l: BotsLocale) =>
      l === 'zh'
        ? '没有这份草稿（已过期、已发送或从未起草）——允许也不会发出任何邮件。'
        : 'No such draft (expired, already sent or never made) — allowing this sends nothing.',
    sendsStored: (l: BotsLocale) =>
      l === 'zh'
        ? '按上面显示的已存草稿原样发送——这次调用带的收件人、主题或正文都会被忽略。'
        : 'Sends the stored draft exactly as shown — any recipients, subject or body passed with this call are ignored.',
    files: (l: BotsLocale, n: number) => (l === 'zh' ? `${n} 个文件` : `${n} file${n === 1 ? '' : 's'}`),
    sharedMailbox: (l: BotsLocale) => (l === 'zh' ? '共享邮箱' : 'the shared mailbox'),
    mailbox: (l: BotsLocale, ref: string) => (l === 'zh' ? `邮箱 ${ref}` : `mailbox ${ref}`),
  },

  notificationBody: (l: BotsLocale) => (l === 'zh' ? '打开 Bots 查看并处理。' : 'Open Bots to review it.'),

  /** The addressed Bot is archived (a DM's owner, or a mentioned guest): the message gets this line, not silence. */
  botArchived: (l: BotsLocale, name: string) =>
    l === 'zh'
      ? `${name} 已归档，无法回复；这段对话保留为只读记录。`
      : `${name} was archived and can't reply — this conversation stays readable.`,

  /** Stop drained a queued wake-up without running it. */
  stoppedWakeup: (l: BotsLocale, name: string) =>
    l === 'zh'
      ? `已停止：${name} 不会自动继续，需要时说一声“继续”。`
      : `Stopped: ${name} won't pick this up on its own — say "continue" when you want it to.`,

  continueAfterCreate: (l: BotsLocale, name: string) =>
    l === 'zh'
      ? `成员确认新建了「${name}」，它已加入本对话。需要时用 team.ask 把工作交给它。`
      : `The member confirmed the new Bot “${name}”; it has joined this conversation. Hand it work with team.ask when it helps.`,
};
