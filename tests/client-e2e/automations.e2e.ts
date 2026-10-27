import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { installPlaces, officialManifest, AUTO } from './p3-fixture';

// The editor's default zone is the browser's; pin it so bodies and previews are exact.
test.use({ timezoneId: 'Asia/Taipei' });

const AGENT = '01JB2Y8Z9QW3E4R5T6Y7V8H9A1';
const at = '2026-10-22T09:00:00Z';

const ready = async (page: Page, path: string) => {
  await page.goto(path);
  await expect(page.getByTestId('startup-splash')).toHaveCount(0);
};

/** p3's station plus automation writes, custom agents, tools and delivery transports. */
async function automationStation(page: Page, { agents: initialAgents = [] as any[] } = {}) {
  const base = await installPlaces(page);
  const writes: { method: string; path: string; body: any }[] = [];
  const tasks: any[] = [{ ...base.automation, notify: { webhook: null, email: false, wecom: false } }];
  const agents: any[] = [...initialAgents];
  let seq = 0;
  const profile = (agent: any) => ({ ...agent, is_custom: true });
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      method = req.method(),
      body = ['POST', 'PUT'].includes(method) ? req.postDataJSON() : null;
    const json = (value: unknown, status = 200) => route.fulfill({ json: value, status });
    if (!['GET', 'OPTIONS'].includes(method) && /^\/api\/(tasks|profiles)/.test(path))
      writes.push({ method, path, body });
    if (path === '/api/extensions')
      return json({
        ...officialManifest(),
        notificationTransports: [
          { id: 'email', title: 'Email', bindingSettings: { preference: 'email', label: 'Email' }, webhook: false },
          { id: 'wecom', title: 'WeCom', bindingSettings: { preference: 'wecom', label: 'WeCom' }, webhook: true },
        ],
        automationTools: [],
      });
    if (path === '/api/tools')
      return json({
        tools: [
          {
            id: 'knowledge_query',
            name: '知识库检索',
            brief: '搜索团队知识库',
            category: 'core',
            surface: { proxy: 'read' },
          },
          { id: 'export_data', name: '导出数据', brief: '导出 CSV', category: 'core' },
          { id: 'tables_mutation', name: '写表格', brief: '新增记录', category: 'team', surface: { proxy: 'write' } },
          { id: 'ask_user', name: '提问', category: 'core', builtin: true },
        ],
      });
    if (path === '/api/me/connectors') return json({ team: [], personal: [] });
    if (path === '/api/profiles')
      return json({
        profiles: [{ id: 'sprouty', name: 'Sprouty', is_custom: false }, ...agents.map(profile)],
        models: [
          { id: 'flash', name: 'Flash' },
          { id: 'deep', name: 'Deep' },
        ],
      });
    if (path === '/api/profiles/custom') {
      if (method === 'POST') {
        const created = {
          id: `custom:${AGENT.slice(0, -1)}${++seq}`,
          user_id: 'member',
          is_shared: false,
          current_version: 1,
          ...body,
        };
        agents.push(created);
        return json(profile(created), 201);
      }
      return json({ profiles: agents.map(profile) });
    }
    const agentMatch = /^\/api\/profiles\/custom\/([^/]+)$/.exec(path);
    if (agentMatch) {
      const index = agents.findIndex((agent) => agent.id === `custom:${agentMatch[1]}`);
      if (method === 'DELETE') {
        agents.splice(index, 1);
        return json({ success: true });
      }
      if (method === 'PUT') {
        agents[index] = { ...agents[index], ...body, current_version: agents[index].current_version + 1 };
        return json(profile(agents[index]));
      }
      return json(profile(agents[index]));
    }
    if (path === '/api/tasks') {
      if (method === 'POST') {
        const created = {
          ...base.automation,
          ...body,
          id: `auto-${++seq + 1}`,
          notify: { webhook: null, email: false, wecom: false, ...body.notify },
          last_run_at: null,
          last_status: null,
          next_run_at: '2026-10-28T00:30:00Z',
          run_count: 0,
        };
        tasks.push(created);
        return json({ task: created }, 201);
      }
      return json({ tasks });
    }
    const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(path);
    if (taskMatch) {
      const task = tasks.find((row) => row.id === taskMatch[1]);
      if (!task) return json({ error: 'Task not found' }, 404);
      if (method === 'PUT') Object.assign(task, body, { notify: { ...task.notify, ...body.notify } });
      return json({ task });
    }
    if (/^\/api\/tasks\/[^/]+\/runs$/.test(path) && !path.includes(AUTO)) return json({ entries: [] });
    return route.fallback();
  });
  return { writes, tasks, agents };
}

const editor = (page: Page) => page.getByTestId('automation-editor');
const agentEditor = (page: Page) => page.getByTestId('agent-editor');
const sidebar = (page: Page) => page.getByTestId('client-secondary');

test('create an automation from a preset schedule', async ({ page }) => {
  const station = await automationStation(page);
  await ready(page, '/automations');
  await page.getByRole('button', { name: '新定时任务', exact: true }).click();
  const dialog = editor(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('名称')).toBeFocused();
  await dialog.getByLabel('名称').fill('周报汇总');
  await dialog.getByLabel('要做的事').fill('每个工作日早上汇总各项目昨天的进展，列出卡点。');
  await dialog.getByRole('radio', { name: '工作日', exact: true }).click();
  await dialog.getByLabel('时刻').fill('08:30');
  await expect(dialog.getByTestId('automation-schedule')).toContainText('工作日 08:30');
  await expect(dialog.getByTestId('automation-schedule')).toContainText('30 8 * * 1-5');
  await expect(dialog.getByRole('list', { name: '接下来' }).getByRole('listitem')).toHaveCount(3);
  await dialog.getByRole('checkbox', { name: '邮件', exact: true }).check();
  await dialog.getByRole('checkbox', { name: '导出数据 — 在运行中产出 CSV/XLSX' }).check();
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const post = station.writes.find((w) => w.method === 'POST' && w.path === '/api/tasks');
  expect(post?.body).toEqual({
    name: '周报汇总',
    task_prompt: '每个工作日早上汇总各项目昨天的进展，列出卡点。',
    schedule: '30 8 * * 1-5',
    timezone: 'Asia/Taipei',
    profile_id: 'sprouty',
    enabled: true,
    max_steps: 15,
    quiet_when_empty: false,
    unattended_tools: ['export_data'],
    notify: { email: true, wecom: false, webhook: null },
  });
  expect(Object.keys(post!.body).some((key) => key.startsWith('notify_'))).toBe(false);
  await expect(sidebar(page).locator('[data-place-row]', { hasText: '周报汇总' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.locator('.gh-place-bar strong').first()).toHaveText('周报汇总');
});

test('the editor refuses what the station would, inline', async ({ page }) => {
  await automationStation(page);
  await ready(page, '/automations');
  await page.getByRole('button', { name: '新定时任务', exact: true }).click();
  const dialog = editor(page);
  await dialog.getByRole('radio', { name: '自定义', exact: true }).click();
  await dialog.getByLabel('Cron 表达式').fill('*/5 * * * *');
  await expect(dialog.getByTestId('automation-schedule')).toContainText('两次运行至少要间隔 15 分钟。');
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await expect(dialog.getByText('名称需要 2 到 50 个字。')).toBeVisible();
  await expect(dialog.getByText('至少写 10 个字。')).toBeVisible();
  await expect(dialog.getByLabel('名称')).toBeFocused();
});

test('edit an existing automation sends only what changed', async ({ page }) => {
  const station = await automationStation(page);
  await ready(page, '/automations');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const dialog = editor(page);
  await expect(dialog.getByLabel('名称')).toHaveValue('每日站会摘要');
  await expect(dialog.getByRole('radio', { name: '工作日', exact: true })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByLabel('名称').fill('站会摘要');
  await dialog.getByRole('radio', { name: '自定义', exact: true }).click();
  await expect(dialog.getByLabel('Cron 表达式')).toHaveValue('0 9 * * 1-5');
  await dialog.getByLabel('Cron 表达式').fill('0 10 * * 1-5');
  await dialog.getByRole('checkbox', { name: '企业微信', exact: true }).check();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(dialog).toHaveCount(0);
  const put = station.writes.find((w) => w.method === 'PUT' && w.path === `/api/tasks/${AUTO}`);
  expect(put?.body).toEqual({ name: '站会摘要', schedule: '0 10 * * 1-5', notify: { wecom: true } });
  await expect(page.locator('.gh-place-bar strong').first()).toHaveText('站会摘要');
});

test('cancel with unsaved changes asks first', async ({ page }) => {
  const station = await automationStation(page);
  await ready(page, '/automations');
  const open = () => page.getByRole('button', { name: '新定时任务', exact: true }).click();
  // nothing typed: closes at once
  await open();
  await editor(page).getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  // typed: Escape asks, keep editing keeps the draft
  await open();
  await editor(page).getByLabel('名称').fill('半成品');
  await page.keyboard.press('Escape');
  const ask = page.getByRole('dialog', { name: '放弃更改？' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(editor(page).getByLabel('名称')).toHaveValue('半成品');
  // ✕ asks again; discard closes without saving
  await editor(page).getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('dialog', { name: '放弃更改？' }).getByRole('button', { name: '放弃', exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  expect(station.writes.filter((w) => w.path === '/api/tasks')).toEqual([]);
});

test('create, edit and delete a custom agent', async ({ page }) => {
  const station = await automationStation(page);
  await ready(page, '/automations?view=agents');
  await expect(page.getByText('还没有自定义 Agent')).toBeVisible();
  await page.getByRole('button', { name: '新建 Agent', exact: true }).first().click();
  const dialog = agentEditor(page);
  await dialog.getByLabel('名称', { exact: true }).fill('值班助手');
  await dialog.getByLabel('指令').fill('你负责值班：先查知识库，再回答。');
  await dialog.getByRole('radio', { name: '蕨', exact: true }).click();
  await dialog.getByRole('radio', { name: '天蓝', exact: true }).click();
  await dialog.getByRole('checkbox', { name: /知识库检索/ }).check();
  await expect(dialog.getByRole('checkbox', { name: /提问/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const post = station.writes.find((w) => w.method === 'POST' && w.path === '/api/profiles/custom');
  expect(post?.body).toMatchObject({
    name: '值班助手',
    system_prompt: '你负责值班：先查知识库，再回答。',
    base_profile_id: 'sprouty',
    model_id: 'flash',
    tools: ['knowledge_query'],
    connectors: null,
    max_steps: 12,
    risk_level: 'medium',
    avatar: { plant: 'fern', tint: 'sky' },
  });
  const detail = page.getByTestId('agent-detail');
  await expect(detail).toContainText('值班助手');
  await expect(detail).toContainText('你负责值班');
  await expect(sidebar(page).getByRole('button', { name: '值班助手', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );

  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await agentEditor(page).getByLabel('指令').fill('你负责周末值班。');
  await agentEditor(page).getByRole('button', { name: '保存', exact: true }).click();
  await expect(agentEditor(page)).toHaveCount(0);
  const put = station.writes.find((w) => w.method === 'PUT' && w.path.startsWith('/api/profiles/custom/'));
  expect(put?.body).toEqual({ system_prompt: '你负责周末值班。' });
  await expect(detail).toContainText('你负责周末值班。');
  await expect(detail).toContainText('v2');

  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  await page
    .getByRole('dialog', { name: '删除「值班助手」？' })
    .getByRole('button', { name: '删除', exact: true })
    .click();
  await expect.poll(() => station.writes.some((w) => w.method === 'DELETE')).toBe(true);
  await expect(page.getByText('还没有自定义 Agent')).toBeVisible();
});

test('duplicate a team agent, and pick an agent in the automation editor', async ({ page }) => {
  const shared = {
    id: `custom:${AGENT}`,
    name: '周报写手',
    description: '团队共享的写作 Agent',
    user_id: 'other',
    owner_nickname: '王宁',
    is_shared: true,
    current_version: 3,
    system_prompt: '写周报。',
    tools: ['knowledge_query', 'crm_query'],
    connectors: null,
    max_steps: 10,
    model_id: 'deep',
    risk_level: 'low',
    avatar: { plant: 'lotus' },
    updated_at: at,
  };
  const station = await automationStation(page, { agents: [shared] });
  await ready(page, `/automations?view=agents&id=${AGENT}`);
  await expect(page.getByTestId('agent-detail')).toContainText('团队共享的写作 Agent');
  await expect(page.getByRole('button', { name: '编辑', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '复制', exact: true }).click();
  const copy = agentEditor(page);
  await expect(copy.getByLabel('名称', { exact: true })).toHaveValue('周报写手（副本）');
  await copy.getByRole('button', { name: '创建', exact: true }).click();
  await expect(copy).toHaveCount(0);
  // a copy keeps only the tools I hold
  expect(station.writes.find((w) => w.method === 'POST')?.body).toMatchObject({
    name: '周报写手（副本）',
    tools: ['knowledge_query'],
    model_id: 'deep',
  });

  await page.getByRole('button', { name: '新定时任务', exact: true }).click();
  const dialog = editor(page);
  const runsAs = dialog.getByLabel('运行身份');
  await expect(runsAs.locator('optgroup[label="自定义 Agent"] option')).toHaveText(['周报写手', '周报写手（副本）']);
  await runsAs.selectOption({ label: '周报写手' });
  await dialog.getByLabel('名称').fill('周五周报');
  await dialog.getByLabel('要做的事').fill('每周五下午写本周周报，发到我的通知。');
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(station.writes.find((w) => w.method === 'POST' && w.path === '/api/tasks')?.body.profile_id).toBe(
    `custom:${AGENT}`,
  );
});

test('automation design captures at 1440', async ({ page }) => {
  const shared = {
    id: `custom:${AGENT}`,
    name: '周报写手',
    description: '每周五汇总各项目进展，写成周报',
    user_id: 'member',
    is_shared: false,
    current_version: 3,
    system_prompt:
      '你是团队的周报写手。\n\n1. 先读本周每个项目的任务变化和卡点。\n2. 按项目写：完成了什么、卡在哪里、下周做什么。\n3. 语气简洁，不超过一页。',
    tools: ['knowledge_query', 'tables_mutation'],
    connectors: null,
    max_steps: 12,
    model_id: 'deep',
    risk_level: 'low',
    purpose: '每周按时交出可读的周报',
    avatar: { plant: 'lotus', tint: 'violet' },
    usage: { total_calls: 42 },
    updated_at: at,
  };
  await automationStation(page, {
    agents: [
      shared,
      {
        ...shared,
        id: 'custom:01JB2Y8Z9QW3E4R5T6Y7V8H9B2',
        name: '值班助手',
        description: '工作日值班答疑',
        avatar: { plant: 'fern' },
        is_shared: true,
      },
    ],
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync('.work/ports/automations', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await ready(page, '/automations');
    await page.evaluate((value) => localStorage.setItem('greenhouse_pref_theme', value), theme);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByTestId('startup-splash')).toHaveCount(0);
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(editor(page).getByRole('list', { name: '接下来' })).toBeVisible();
    await page.screenshot({ path: `.work/ports/automations/automation-editor-${theme}.png` });
    await editor(page)
      .locator('.gh-dialog-body')
      .evaluate((body) => body.scrollTo(0, body.scrollHeight));
    await page.screenshot({ path: `.work/ports/automations/automation-editor-lower-${theme}.png` });
    await editor(page).getByRole('button', { name: '取消', exact: true }).click();
    await ready(page, `/automations?view=agents&id=${AGENT}`);
    await expect(page.getByTestId('agent-detail')).toContainText('周报写手');
    await page.screenshot({ path: `.work/ports/automations/agents-list-${theme}.png` });
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(agentEditor(page).getByRole('checkbox', { name: /知识库检索/ })).toBeChecked();
    await page.screenshot({ path: `.work/ports/automations/agent-editor-${theme}.png` });
    await agentEditor(page).getByRole('button', { name: '取消', exact: true }).click();
  }
});
