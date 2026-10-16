/**
 * Mock data and pure state rules for the v2 prototype.
 * Information architecture follows docs/product/prd.md §6.
 */

export type ModuleId =
  | 'chat'
  | 'knowledge'
  | 'tables'
  | 'apps'
  | 'skills'
  | 'agents'
  | 'runs'
  | 'notifications'
  | 'settings'
  | 'admin'
  | 'login'
  | 'components';

/** Where a module's entry lives in the shell. */
export type Placement = 'rail' | 'more' | 'bottom' | 'account' | 'hidden';

export const modules: { id: ModuleId; label: string; placement: Placement }[] = [
  { id: 'chat', label: '对话', placement: 'rail' },
  { id: 'knowledge', label: '知识库', placement: 'rail' },
  { id: 'tables', label: '表格', placement: 'rail' },
  { id: 'apps', label: '应用', placement: 'rail' },
  { id: 'skills', label: '技能', placement: 'more' },
  { id: 'agents', label: 'Agents', placement: 'more' },
  { id: 'runs', label: '运行', placement: 'bottom' },
  { id: 'notifications', label: '通知', placement: 'bottom' },
  { id: 'settings', label: '设置', placement: 'account' },
  { id: 'admin', label: '管理', placement: 'account' },
  { id: 'login', label: '登录', placement: 'hidden' },
  { id: 'components', label: '组件', placement: 'hidden' },
];

export const moduleLabel = (id: ModuleId) => modules.find((item) => item.id === id)!.label;

/** The one primary action each module column carries (PRD §6.1). */
export const createLabel: Partial<Record<ModuleId, string>> = {
  chat: '新会话',
  knowledge: '新建',
  tables: '新建表格',
  apps: '新建应用',
  skills: '新建技能',
  agents: '新建 Agent',
};

// ─── Records (the 产品计划 base, built from the 项目 template) ───

export type Status = '待处理' | '进行中' | '已完成';
export interface RecordItem {
  id: string;
  title: string;
  status: Status;
  owner: string;
  priority: '高' | '中' | '低';
  start: string;
  date: string;
  note: string;
}
export const initialRecords: RecordItem[] = [
  {
    id: 'GH-104',
    title: '完善成员邀请流程',
    status: '进行中',
    owner: '林杰',
    priority: '高',
    start: '2026-10-12',
    date: '2026-10-16',
    note: '邀请链接失效后，允许管理员重新发送。',
  },
  {
    id: 'GH-103',
    title: '更新产品使用指南',
    status: '待处理',
    owner: '陈晨',
    priority: '中',
    start: '2026-10-15',
    date: '2026-10-18',
    note: '补充数据视图与共享权限的说明。',
  },
  {
    id: 'GH-102',
    title: '对齐首页卡片样式',
    status: '进行中',
    owner: '林杰',
    priority: '中',
    start: '2026-10-11',
    date: '2026-10-15',
    note: '统一间距，去掉重复信息。',
  },
  {
    id: 'GH-101',
    title: '整理客户访谈',
    status: '已完成',
    owner: '周宁',
    priority: '低',
    start: '2026-10-08',
    date: '2026-10-12',
    note: '合并访谈记录，保留关键问题与原始引用。',
  },
  {
    id: 'GH-100',
    title: '检查数据导入错误',
    status: '待处理',
    owner: '陈晨',
    priority: '高',
    start: '2026-10-13',
    date: '2026-10-14',
    note: '在提交前展示缺失字段和重复记录。',
  },
  {
    id: 'GH-099',
    title: '准备周会材料',
    status: '已完成',
    owner: '周宁',
    priority: '低',
    start: '2026-10-10',
    date: '2026-10-11',
    note: '汇总本周完成项与下周安排。',
  },
  {
    id: 'GH-098',
    title: '确认移动端导航',
    status: '待处理',
    owner: '林杰',
    priority: '中',
    start: '2026-10-16',
    date: '2026-10-20',
    note: '验证抽屉导航和详情弹框。',
  },
  {
    id: 'GH-097',
    title: '归档旧版设计',
    status: '已完成',
    owner: '陈晨',
    priority: '低',
    start: '2026-10-09',
    date: '2026-10-10',
    note: '历史资料保留在归档目录。',
  },
];
export function saveRecord(records: RecordItem[], record: RecordItem): RecordItem[] {
  if (!record.title.trim()) throw new Error('请输入标题');
  return records.some((item) => item.id === record.id)
    ? records.map((item) => (item.id === record.id ? { ...record, title: record.title.trim() } : item))
    : [{ ...record, title: record.title.trim() }, ...records];
}

export type ApprovalState = 'pending' | 'accepted' | 'rejected' | 'expired';
export interface Approval {
  state: ApprovalState;
  expiresAt: number;
}
export function decideApproval(approval: Approval, decision: 'accepted' | 'rejected', now: number): Approval {
  if (approval.state !== 'pending') return approval;
  return { ...approval, state: now >= approval.expiresAt ? 'expired' : decision };
}

// ─── Knowledge ───

export const folders = ['产品', '研究', '设计'] as const;
export const documents = [
  {
    id: 'doc-1',
    title: '产品使用指南',
    kind: '文档',
    folder: '产品',
    scope: '团队',
    date: '今天',
    content:
      '从一个问题开始\n\n在对话里说清要做什么。Agent 会给出来源；需要改数据时，先请你确认。\n\n整理团队信息\n\n知识库保存依据；表格组织事实；应用把表格交给同事使用。三者都能在对话里引用。',
  },
  {
    id: 'doc-2',
    title: '10 月产品计划',
    kind: '文档',
    folder: '产品',
    scope: '团队',
    date: '昨天',
    content:
      '目标\n\n减少完成任务的步骤，让页面只保留当下需要的信息。\n\n本月工作\n\n完成成员邀请、数据导入和移动端导航。每周五检查进度。',
  },
  {
    id: 'doc-3',
    title: '客户访谈.pdf',
    kind: 'PDF',
    folder: '研究',
    scope: '团队',
    date: '10 月 10 日',
    content:
      '访谈摘录\n\n“我希望先看到需要我处理的事，再看所有任务。”\n\n“从对话点开一条记录，处理完后继续聊，比切换页面顺手。”',
  },
  {
    id: 'doc-4',
    title: '品牌素材.zip',
    kind: '文件',
    folder: '设计',
    scope: '团队',
    date: '10 月 9 日',
    content: '品牌资料\n\n标志、字体和色彩由同一套设计源维护。',
  },
  {
    id: 'doc-5',
    title: '我的周会笔记',
    kind: '文档',
    folder: '产品',
    scope: '个人',
    date: '10 月 8 日',
    content: '待办\n\n确认移动端导航的抽屉顺序。',
  },
];

// ─── Agents, rooms and chats ───

export type PlantName = 'sprout' | 'fern' | 'sunflower' | 'dandelion' | 'opuntia' | 'clover';
export interface AgentItem {
  id: string;
  name: string;
  role: string;
  plant: PlantName;
  description: string;
  kind: '主 Agent' | '私有' | '公开';
  owner: string;
  status: '空闲' | '运行中' | '需要你';
  needs?: number;
}
export const agents: AgentItem[] = [
  {
    id: 'greeny',
    name: 'Greeny',
    role: '你的主 Agent',
    plant: 'sprout',
    description: '日常交办的第一站：查资料、整理任务，必要时找其他 Agent 帮忙。',
    kind: '主 Agent',
    owner: '林杰',
    status: '空闲',
  },
  {
    id: 'weekly',
    name: '葵葵',
    role: '周报',
    plant: 'sunflower',
    description: '每周五汇总项目进展，生成周报草稿。',
    kind: '私有',
    owner: '林杰',
    status: '运行中',
  },
  {
    id: 'triage',
    name: '卷卷',
    role: 'IT 工单分诊',
    plant: 'fern',
    description: '分类新工单，给出处理建议；改状态前请你确认。',
    kind: '私有',
    owner: '林杰',
    status: '需要你',
    needs: 1,
  },
  {
    id: 'research',
    name: '蒲蒲',
    role: '研究员',
    plant: 'dandelion',
    description: '比较信息、保留来源，整理研究结论。',
    kind: '公开',
    owner: '陈晨',
    status: '空闲',
  },
];
export const rooms = [
  { id: 'room-launch', name: '产品发布', members: '林杰、陈晨、周宁 · 2 个 Agent', unread: true },
  { id: 'dm-chen', name: '陈晨', members: '私信', unread: false },
];
export const chats = {
  pinned: ['采购预算分析'],
  today: ['本周 IT 工单', '客户反馈总结'],
  earlier: ['整理会议记录', '竞品价格对比', '季度目标草稿'],
};

// ─── Runs ───

export interface RunItem {
  id: string;
  title: string;
  state: '需要你' | '运行中' | '排队中' | '已完成' | '失败' | '已取消';
  agent: string;
  source: '对话' | '定时' | '表格';
  time: string;
}
export const runs: RunItem[] = [
  { id: 'run-1', title: '更新本周任务状态', state: '需要你', agent: '卷卷', source: '对话', time: '刚刚' },
  { id: 'run-2', title: '整理客户访谈', state: '运行中', agent: '蒲蒲', source: '对话', time: '2 分钟前' },
  { id: 'run-3', title: '生成周报', state: '已完成', agent: '葵葵', source: '定时', time: '10:30' },
  { id: 'run-4', title: '同步供应商报价', state: '失败', agent: 'Greeny', source: '定时', time: '09:00' },
  { id: 'run-5', title: '新工单自动分诊', state: '已完成', agent: '卷卷', source: '表格', time: '昨天' },
];
export const schedules = [
  { id: 'sch-1', title: '生成周报', agent: '葵葵', rule: '每周五 10:30', next: '10 月 16 日', enabled: true },
  { id: 'sch-2', title: '同步供应商报价', agent: 'Greeny', rule: '每天 09:00', next: '明天 09:00', enabled: true },
];

// ─── Apps and skills ───

export const apps = [
  {
    id: 'app-it',
    name: 'IT 工单',
    description: '提交与处理团队 IT 问题',
    base: 'IT 支持',
    pinned: true,
    owner: '林杰',
  },
  {
    id: 'app-buy',
    name: '采购申请',
    description: '提交、审批与跟进采购',
    base: '采购管理',
    pinned: true,
    owner: '陈晨',
  },
  {
    id: 'app-crm',
    name: '轻量 CRM',
    description: '跟进客户与销售机会',
    base: '客户清单',
    pinned: false,
    owner: '周宁',
  },
];
export const skills = [
  {
    id: 'sk-weekly',
    name: '整理周报',
    kind: '模板',
    scope: '团队',
    version: 'v3',
    description: '汇总本周进度与下周安排。',
    variables: ['项目', '风格'],
  },
  {
    id: 'sk-interview',
    name: '总结访谈',
    kind: '模板',
    scope: '我的',
    version: 'v1',
    description: '提炼关键问题，保留原始引用。',
    variables: ['访谈文档'],
  },
  {
    id: 'sk-pdf',
    name: 'PDF 报告生成',
    kind: '技能包',
    scope: '团队',
    version: 'v1.2.0',
    description: '把 Markdown 排成带封面和目录的 PDF。',
    requires: '需要电脑',
  },
  {
    id: 'sk-crm',
    name: '客户跟进记录',
    kind: '技能包',
    scope: '团队',
    version: 'v0.4.1',
    description: '把会议纪要写回 CRM 表格。',
    requires: '需要「表格」权限',
  },
];

// ─── Settings and admin ───

export type Capability = 'llm' | 'stt' | 'tts' | 'image' | 'video' | 'sandbox' | 'search' | 'storage';
export interface ProviderInstance {
  id: string;
  name: string;
  preset: string;
  source: '环境变量' | '工作区' | '我的';
  status: '可用' | '不可用' | '未测试';
}
export const capabilities: { id: Capability; label: string; hint: string; personal: boolean }[] = [
  {
    id: 'llm',
    label: '大模型',
    hint: '所有对话、后台运行、标题与摘要都用它。内容会发送给所选服务商。',
    personal: true,
  },
  { id: 'stt', label: '语音输入', hint: '输入框的麦克风。没有配置时，使用浏览器自带的识别。', personal: true },
  { id: 'tts', label: '语音输出', hint: '消息的「朗读」。没有配置时，使用浏览器自带的朗读。', personal: true },
  { id: 'image', label: '图像', hint: 'Agent 生成和编辑图片。没有配置时，这项能力不会出现。', personal: true },
  { id: 'video', label: '视频', hint: 'Agent 生成短视频，以后台运行的方式完成。', personal: false },
  {
    id: 'sandbox',
    label: '沙箱',
    hint: 'Agent 的电脑和长时间运行。没有配置时，电脑相关入口不会出现。',
    personal: false,
  },
  { id: 'search', label: '搜索', hint: 'Agent 搜索网页、读取网页内容。', personal: false },
  { id: 'storage', label: '存储', hint: '所有上传文件、产物与导出。没有配置时，使用本地磁盘。', personal: false },
];
export const workspaceProviders: Record<Capability, ProviderInstance[]> = {
  llm: [
    { id: 'p-ds', name: '公司 DeepSeek', preset: 'DeepSeek', source: '环境变量', status: '可用' },
    { id: 'p-claude', name: 'Claude', preset: 'Anthropic', source: '工作区', status: '可用' },
  ],
  stt: [{ id: 'p-sf', name: '硅基流动 SenseVoice', preset: '硅基流动', source: '工作区', status: '可用' }],
  tts: [{ id: 'p-mm', name: 'MiniMax 语音', preset: 'MiniMax', source: '工作区', status: '未测试' }],
  image: [{ id: 'p-gi', name: 'OpenAI 图像', preset: 'OpenAI', source: '工作区', status: '可用' }],
  video: [],
  sandbox: [{ id: 'p-dk', name: '本机 Docker', preset: 'Docker + gVisor', source: '环境变量', status: '可用' }],
  search: [
    { id: 'p-tv', name: 'Tavily', preset: 'Tavily', source: '工作区', status: '可用' },
    { id: 'p-br', name: 'Brave', preset: 'Brave', source: '工作区', status: '不可用' },
  ],
  storage: [{ id: 'p-cos', name: '腾讯云 COS', preset: 'S3 兼容 · 腾讯 COS', source: '环境变量', status: '可用' }],
};
export const presets: Record<Capability, string[]> = {
  llm: [
    'OpenAI',
    'Anthropic',
    'Gemini',
    'DeepSeek',
    'Kimi',
    '通义千问',
    '豆包',
    '智谱 GLM',
    'MiniMax',
    '硅基流动',
    'OpenRouter',
    'Ollama（本地）',
    'OpenAI 兼容',
  ],
  stt: ['OpenAI', '硅基流动', 'Groq', '阿里云百炼', 'Deepgram', '本地 Whisper'],
  tts: ['OpenAI', 'ElevenLabs', 'MiniMax', '阿里云 CosyVoice', '硅基流动'],
  image: ['OpenAI', 'Gemini', '通义万相', '豆包 Seedream', '302.AI'],
  video: ['Sora', 'Veo', '可灵', '通义万相 Wan', 'Seedance', '海螺'],
  sandbox: ['Docker + gVisor', 'E2B', 'E2B 兼容（PPIO 等）'],
  search: ['Tavily', 'Brave', 'Exa', 'Jina', 'Firecrawl', 'SearXNG', '博查'],
  storage: ['本地磁盘', 'AWS S3', 'Cloudflare R2', 'MinIO', '腾讯 COS', '阿里 OSS', '华为 OBS'],
};
export const connections = [
  { id: 'c-gh', name: 'GitHub', kind: '工具', state: '已连接', detail: 'linjie · 读写仓库与 Issue' },
  { id: 'c-notion', name: 'Notion', kind: '工具', state: '未连接', detail: '管理员已安装' },
  { id: 'c-feishu', name: '飞书', kind: '账号', state: '已连接', detail: '用于登录、通知与机器人' },
  { id: 'c-wecom', name: '企业微信', kind: '账号', state: '未连接', detail: '用于通知' },
  { id: 'c-mail', name: '工作邮箱', kind: '邮箱', state: '已过期', detail: 'linjie@example.com · IMAP / SMTP' },
];
export const members = [
  { name: '林杰', email: 'super@greenhouse.local', role: '管理员', budget: '不限' },
  { name: '陈晨', email: 'team@greenhouse.local', role: '成员', budget: '2M tokens / 月' },
  { name: '周宁', email: 'zhou@greenhouse.local', role: '成员', budget: '2M tokens / 月' },
];

// ─── Chat scenarios (prototype controls only) ───

export const scenarioOptions = [
  ['overview', '完整对话'],
  ['stream', '生成与停止'],
  ['tools', '工具与重试'],
  ['approval', '需要你：批准'],
  ['requests', '需要你：其他类型'],
  ['rich', '表格与图表'],
  ['media', '图片、视频与音频'],
  ['artifact', '文件与产物'],
  ['error', '错误与重试'],
  ['readonly', '只读对话'],
  ['empty', '新会话'],
] as const;
export type Scenario = (typeof scenarioOptions)[number][0];

export function downloadText(filename: string, content: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}
