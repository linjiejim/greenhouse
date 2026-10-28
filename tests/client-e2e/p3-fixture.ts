import type { Page } from '@playwright/test';
import { installStation, DOC } from './p2-fixture';
const at = '2026-10-22T09:00:00Z';
export const FILE = 'file_01JB2Y8Z9QW3E4R5T6Y7V8H9P0',
  // Object routes validate real wire ids (legacy decimal ids are valid too).
  BASE = '11',
  TABLE = '12',
  PROJECT = '21',
  TASK = '22',
  AUTO = 'auto-1';
export function officialManifest() {
  return {
    manifest_version: 2,
    core: { version: '4.0.0', client_api: 4 },
    plugins: ['knowledge', 'tables', 'projects'].map((id, i) => ({
      id,
      name: id,
      version: '4.0.0',
      official: true,
      description: null,
      features: [],
      mcp_groups: [],
      entity_kinds: [],
      entities: [],
      nav: [
        {
          id,
          label: { zh: { knowledge: '知识库', tables: '表格', projects: '项目' }[id], en: id },
          page: 'index',
          icon: 'BookOpen',
          placement: 'primary',
          order: i,
        },
      ],
      pages: [{ id: 'index', title: id, kind: 'native', screen: id }],
    })),
  };
}
export async function installPlaces(page: Page) {
  const station = await installStation(page);
  const writes: { path: string; body: any; method: string }[] = [];
  const baseTables = [{ id: TABLE, name: '反馈', base_id: BASE }];
  const folders = [
    { id: 'folder-hr', name: '人事制度', parent_id: null, visibility: 'team', created_at: at, updated_at: at },
  ];
  const docs = [
    {
      id: DOC,
      slug: 'remote-work',
      title: '远程办公政策',
      folder_id: 'folder-hr',
      visibility: 'team',
      status: 'published',
      tags: '["hr","policy"]',
      updated_by: 'member',
      summary: '全远程：美西 ±3 小时内工作，核心工时 10:00–14:00，一次性 1,000 美元加每月 75 美元补贴。',
      content_markdown:
        '## 在哪里工作\n\n可以在美西时区 ±3 小时范围内的任何地方工作。\n\n## 核心工时\n\n工作日 10:00–14:00 保持可联系。\n\n## 居家补贴\n\n一次性 1,000 美元，每月 75 美元。\n\n## 休假\n\n无限年假，每年至少休 15 天。',
      content_json: '{}',
      created_at: at,
      updated_at: at,
    },
  ];
  const files = [
    {
      id: FILE,
      name: 'Q4 活动方案.docx',
      folder_id: null,
      visibility: 'team',
      content_type: 'text/plain',
      size: 1200000,
      uploaded_by: '王宁',
      created_at: at,
      updated_at: at,
    },
  ];
  const fields = [
    { id: 'f-customer', name: '客户', type: 'text', is_primary: true, position: 0 },
    {
      id: 'f-channel',
      name: '渠道',
      type: 'single_select',
      config: JSON.stringify({
        options: [
          { id: 'support', label: '支持' },
          { id: 'nps', label: 'NPS 调研' },
        ],
      }),
    },
    { id: 'f-score', name: '评分', type: 'number' },
    { id: 'f-summary', name: '摘要', type: 'text' },
  ].map((f) => ({ ...f, table_id: TABLE, archived_at: null, required: false, config: '{}', ...f }));
  const records = [
    {
      id: '13',
      table_id: TABLE,
      values: {
        'f-customer': 'Wayne Enterprises',
        'f-channel': 'support',
        'f-score': 6,
        'f-summary': '问怎么批量导入记录到表格',
      },
      revision: 1,
      created_at: at,
      updated_at: at,
      created_by: 'member',
      updated_by: null,
    },
  ];
  const tasks = [
    {
      id: TASK,
      project_id: PROJECT,
      parent_id: null,
      title: '定价页文案',
      description: '三档价格对比表 + FAQ。',
      status: 'in_progress',
      priority: 'high',
      assignee_id: 'member',
      assignee_nickname: '林杰',
      due_date: '2026-10-27',
      start_date: '2026-10-22',
      created_at: at,
      updated_at: at,
      sort_order: 0,
    },
    {
      id: '23',
      project_id: PROJECT,
      parent_id: null,
      title: '写上线公告',
      status: 'todo',
      priority: 'normal',
      assignee_id: 'member',
      assignee_nickname: '王宁',
      due_date: '2026-10-30',
      start_date: '2026-10-22',
      created_at: at,
      updated_at: at,
      sort_order: 1,
    },
  ];
  const project = {
    id: PROJECT,
    title: 'Q4 新品上线',
    status: 'active',
    color: null,
    progress: 68,
    stats: { total: 2, todo: 1, in_progress: 1, in_review: 0, done: 0, cancelled: 0 },
    created_at: at,
    updated_at: at,
  };
  const automation = {
    id: AUTO,
    user_id: 'member',
    name: '每日站会摘要',
    task_prompt:
      '每个工作日早上 9 点，汇总昨天各项目的任务变化，按项目列出：完成了什么、卡在哪里、今天要做什么。发到我的通知里。',
    profile_id: 'sprouty',
    schedule: '0 9 * * 1-5',
    timezone: 'Asia/Taipei',
    enabled: true,
    last_run_at: at,
    last_status: 'succeeded',
    next_run_at: '2026-10-28T01:00:00Z',
    run_count: 4,
    created_at: at,
    updated_at: at,
  };
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      method = req.method(),
      body =
        ['POST', 'PATCH', 'PUT'].includes(method) && req.headers()['content-type']?.includes('json')
          ? req.postDataJSON()
          : null;
    const json = (value: unknown) => route.fulfill({ json: value });
    if (!['GET', 'OPTIONS'].includes(method)) writes.push({ path, body, method });
    if (path === '/api/sessions/shareable-users') return json({ users: [{ id: 'member', nickname: '林杰' }] });
    if (path === '/api/auth/me')
      return json({
        user: {
          id: 'member',
          role: 'super',
          nickname: 'Jim Lin',
          email: 'jim@test.local',
          locale: 'zh',
          features: { tables: true },
        },
      });
    if (path === '/api/extensions') return json(officialManifest());
    if (path === '/api/knowledge/docs') return json({ docs });
    if (path === `/api/knowledge/docs/id/${DOC}`) return json({ doc: docs[0] });
    if (path === `/api/knowledge/docs/${DOC}` && method === 'PUT') {
      Object.assign(docs[0], body);
      return json({ doc: docs[0] });
    }
    if (path === '/api/drive/folders')
      return json({ folders: url.searchParams.get('parent_id') === 'all' ? folders : [] });
    if (path === '/api/drive/files') return json({ files });
    if (path === '/api/drive/files/init')
      return json({ file_id: 'new-file', mode: 'proxy', upload_url: '/api/drive/bytes' });
    if (path === '/api/drive/bytes') return json({ ok: true });
    if (path === `/api/drive/files/${FILE}`) {
      if (method === 'PUT') Object.assign(files[0], body);
      if (method === 'DELETE') files.splice(0, 1);
      return json({ file: files[0] });
    }
    if (path === `/api/drive/files/${FILE}/content`)
      return route.fulfill({ body: '2026 Q4 品牌活动方案', contentType: 'text/plain' });
    if (path === '/api/tables/bases')
      return json({ bases: [{ id: BASE, name: '客户反馈', role: 'owner', visibility: 'team' }] });
    if (path === `/api/tables/bases/${BASE}`)
      return json({
        base: { id: BASE, name: '客户反馈' },
        role: 'owner',
        tables: baseTables,
      });
    if (path === `/api/tables/tables/${TABLE}/archive` && method === 'POST') {
      baseTables.splice(0, baseTables.length);
      return json({ table: { id: TABLE, name: '反馈', base_id: BASE } });
    }
    if (path === `/api/tables/tables/${TABLE}/schema`)
      return json({ table: { id: TABLE, name: '反馈', base_id: BASE }, fields });
    if (path === `/api/tables/tables/${TABLE}/views`)
      return json({
        views: [
          { id: 'channel', name: '按渠道', config: { fieldIds: ['f-channel', 'f-customer', 'f-score', 'f-summary'] } },
        ],
      });
    if (path === `/api/tables/tables/${TABLE}/records/query`)
      return json({ records, hasMore: false, nextCursor: null });
    if (path === `/api/tables/tables/${TABLE}/records/13`) return json({ record: records[0] });
    if (path === '/api/projects') return json({ projects: [project], total: 1 });
    if (path === '/api/projects/gantt') return json({ projects: [{ ...project, tasks }] });
    if (path === `/api/projects/${PROJECT}`)
      return json({ project, tasks, members: [], stats: project.stats, progress: 68 });
    if (path === `/api/projects/tasks/${TASK}` && method === 'PATCH') {
      Object.assign(tasks[0], body);
      return json({ task: tasks[0] });
    }
    if (path.endsWith('/comments')) return json({ comments: [] });
    if (path === '/api/tasks') return json({ tasks: [automation] });
    if (path === `/api/tasks/${AUTO}`) {
      if (method === 'PUT') Object.assign(automation, body);
      return json({ task: automation });
    }
    if (path === `/api/tasks/${AUTO}/run`) return json({ ok: true, session_id: 'policy-chat' });
    if (path === `/api/tasks/${AUTO}/runs`)
      return json({
        entries: [
          {
            session_id: 'policy-chat',
            title: '4 个项目 · 2 个卡点',
            created_at: at,
            run: { id: 'run-1', status: 'succeeded', trigger: 'scheduled', started_at: at, ended_at: at },
          },
        ],
      });
    return route.fallback();
  });
  return { station, writes, docs, tasks, automation };
}
