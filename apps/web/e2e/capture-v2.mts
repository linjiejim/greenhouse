/** Seeded product screenshots, against e2e/stack.sh only. Requires Playwright Chromium and cwebp. */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect, type Page } from '@playwright/test';
import type { AppDraft, Base, Conversation, MemberSummary, TokenPair } from '@greenhouse/contract';
import { PEOPLE } from './env.ts';

const origin = `http://127.0.0.1:${process.env.STACK_WEB_PORT ?? 4580}`;
const output = process.env.SCREENSHOT_DIR ?? 'docs/assets/v2';
const review = process.env.SCREENSHOT_REVIEW_DIR ?? 'artifacts/t10/after';
await mkdir(output, { recursive: true });
await mkdir(review, { recursive: true });
const browser = await chromium.launch();
const results: Array<Record<string, unknown>> = [];
const contexts = new Map<string, Awaited<ReturnType<typeof browser.newContext>>>();
try {
  for (const who of ['lin', 'mei'] as const) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
    const response = await context.request.post(`${origin}/api/auth/login`, {
      data: { email: PEOPLE[who].email, password: PEOPLE[who].password, client: 'web' },
    });
    if (!response.ok()) throw new Error(`Sample sign-in: ${response.status()}`);
    const tokens = (await response.json()) as TokenPair;
    await context.setExtraHTTPHeaders({ authorization: `Bearer ${tokens.access_token}` });
    await context.addInitScript((value) => localStorage.setItem('greenhouse.session', JSON.stringify(value)), tokens);
    contexts.set(who, context);
  }
  const lin = contexts.get('lin')!;
  async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
    const response = await lin.request.fetch(`${origin}/api${path}`, { method, ...(data ? { data } : {}) });
    if (!response.ok()) throw new Error(`${method} ${path}: ${response.status()} ${await response.text()}`);
    return (response.status() === 204 ? {} : await response.json()) as T;
  }
  // Refuse real services: the script creates data and sends prompts to the model.
  const providers = await api<{
    capabilities: Array<{ capability: string; instances: Array<{ config: Record<string, unknown> }> }>;
  }>('/admin/providers');
  const models = providers.capabilities.find((entry) => entry.capability === 'llm')?.instances ?? [];
  if (
    !models.length ||
    models.some((entry) => {
      try {
        return !['127.0.0.1', 'localhost'].includes(new URL(String(entry.config.baseUrl)).hostname);
      } catch {
        return true;
      }
    })
  )
    throw new Error('Use the local fake-model stack; refusing a remote model.');

  const people = await api<{ items: MemberSummary[] }>('/members');
  const mei = people.items.find((person) => person.name === 'Mei')!;
  const bases = await api<{ items: Array<{ id: string; name: string }> }>('/tables/bases');
  const existing = bases.items.find((item) => item.name === '产品发布计划');
  const base = existing
    ? await api<Base>(`/tables/bases/${existing.id}`)
    : await api<Base>('/tables/bases', 'POST', { name: '产品发布计划', template: 'project' });
  await api(`/tables/bases/${base.id}/share`, 'PUT', { items: [{ type: 'member', id: mei.id, role: 'editor' }] });
  const table = base.tables.find((item) => item.name === '任务') ?? base.tables[0]!;
  const doc = await api<{ id: string }>('/knowledge/docs', 'POST', {
    title: '发布协作指南',
    space: 'team',
    content:
      '# 一起把工作做完\n\n每周一更新发布计划；周五在房间里回顾进展。\n\n## 发布前检查\n\n- [x] 知识库保留决定与来源\n- [x] 表格记录负责人、状态与日期\n- [ ] 在预览环境确认浅色、深色和窄屏\n\n## 工作方式\n\n先在对话中说明目标，涉及外部操作时确认后再执行。天气范围写作 19~24°C。\n\n| 对象 | 用途 |\n| --- | --- |\n| 对话 | 讨论目标与结果 |\n| 表格 | 跟踪共享工作 |\n| 应用 | 为成员提供日常入口 |',
  });
  let app = await api<AppDraft>('/apps', 'POST', {
    base_id: base.id,
    name: '发布协作',
    description: '把共享计划变成每个人的日常入口。',
  });
  const fields = table.fields
    .filter((field) => ['text', 'select', 'date', 'member'].includes(field.type))
    .map((field) => field.id);
  app = await api<AppDraft>(`/apps/${app.app.id}/draft`, 'PUT', {
    revision: app.revision,
    name: app.app.name,
    description: app.app.description,
    spec: {
      pages: [
        {
          id: 'home',
          name: '发布计划',
          cards: [{ id: 'tasks', kind: 'records', title: '本周的工作', table_id: table.id, fields, actions: [] }],
        },
      ],
      roles: [{ id: 'reader', name: '成员', rules: { tables: { [table.id]: { access: 'read' } } } }],
    },
  });
  await api(`/apps/${app.app.id}/publish`, 'POST', {
    revision: app.revision,
    audience: [{ principal_type: 'workspace', principal_id: null, role: 'reader' }],
  });
  const agent = await api<{ id: string }>('/agents', 'POST', { name: '发布助手' });
  const direct = await api<{ id: string }>('/conversations', 'POST', { kind: 'direct', agent_id: agent.id });
  const chat = await api<{ id: string }>('/conversations', 'POST', { kind: 'chat', title: '本周工作' });
  const room = await api<{ id: string }>('/conversations', 'POST', {
    kind: 'room',
    title: '发布协作室',
    member_ids: [mei.id],
    agent_ids: [agent.id],
  });
  const schedule = await api<{ id: string }>('/schedules', 'POST', {
    agent_id: agent.id,
    name: '周五进度回顾',
    brief: 'Summarize the release progress.',
    cron: '0 16 * * 5',
    timezone: 'Asia/Taipei',
  });
  const run = await api<{ last_run_id: string }>(`/schedules/${schedule.id}/run-now`, 'POST');
  await api('/skills', 'POST', {
    kind: 'template',
    name: 'weekly-review',
    display_name: '每周回顾',
    description: '把本周的进展、决定与下一步整理成一页。',
    body: '请整理本周的进展、决定与下一步，保留来源。',
    space: 'team',
  });
  await api(`/knowledge/docs/${doc.id}/comments`, 'POST', { body: '每周回顾请在这里补充决定与出处。' });
  const page = await lin.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/#/c/main`);
  const composer = page.getByRole('textbox', { name: /发消息|Message/ });
  await composer.fill('look up 发布协作指南');
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: '查看来源：发布协作指南' })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeHidden();

  async function capture(target: Page, name: string, publish = false) {
    for (const [theme, width] of [
      ['light', 1440],
      ['dark', 1440],
      ['light', 390],
    ] as const) {
      await target.setViewportSize({ width, height: 900 });
      await target.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await target.evaluate(() => document.fonts.ready);
      await target.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      const path = `${review}/${name}-${theme}-${width}.png`;
      await target.screenshot({ path, animations: 'disabled', fullPage: true });
      const overflow = await target.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      const unnamed = await target
        .locator('button:visible')
        .evaluateAll((buttons) =>
          buttons
            .filter(
              (button) =>
                !(
                  button.textContent?.trim() ||
                  button.getAttribute('aria-label') ||
                  button.getAttribute('aria-labelledby') ||
                  button.getAttribute('title')
                ),
            )
            .map((button) => button.outerHTML.slice(0, 220)),
        );
      results.push({ name, theme, width, path, overflow, unnamed, errors: [...errors] });
      errors.length = 0;
      if (publish && width === 1440)
        execFileSync('cwebp', [
          '-quiet',
          '-q',
          '76',
          '-resize',
          '1440',
          '900',
          path,
          '-o',
          `${output}/${name}-${theme}.webp`,
        ]);
    }
    await target.setViewportSize({ width: 1440, height: 900 });
  }
  await composer.fill('show stats');
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeHidden();
  await expect(page.getByText('This week', { exact: true })).toBeVisible();
  await capture(page, 'conversation', true);
  await page.goto(`${origin}/#/c/${direct.id}`);
  await composer.fill('remember 每周五整理发布进展，并保留决定的出处');
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: '撤销这次写入' })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeHidden();
  await capture(page, 'receipt', true);
  const folder = await api<{ id: string }>('/knowledge/folders', 'POST', {
    name: '发布回顾',
    space: 'team',
  });
  await composer.fill(`shared draft in ${folder.id}`);
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: '批准', exact: true })).toBeVisible();
  await capture(page, 'approval', true);

  await page.goto(`${origin}/#/c/${room.id}`);
  await composer.fill('@');
  await page.getByRole('option', { name: /发布助手/ }).click();
  await composer.pressSequentially('请把本周的进展与决定留在发布协作指南里。');
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeHidden();
  await expect(page.locator('.app-room-roster')).toContainText('发布助手');
  const other = await contexts.get('mei')!.newPage();
  await other.goto(`${origin}/#/c/${room.id}`);
  await other.getByRole('textbox', { name: /发消息|Message/ }).fill('浅色、深色和手机预览已检查，周五一起回顾。');
  await other.getByRole('textbox', { name: /发消息|Message/ }).press('Enter');
  await expect(page.getByText('浅色、深色和手机预览已检查，周五一起回顾。', { exact: true })).toBeVisible();
  await capture(page, 'room', true);
  await other.close();

  // Opt in only with stack.sh's local computer image; never manufacture a screen.
  if (process.env.SCREENSHOT_COMPUTER === '1') {
    await api(`/agents/${agent.id}/computer/start`, 'POST');
    await page.goto(`${origin}/#/agents/${agent.id}?tab=computer`);
    await expect(page.getByRole('button', { name: '关机', exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        () =>
          page
            .locator('canvas')
            .first()
            .evaluate((canvas: HTMLCanvasElement) => {
              const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
              return pixels.some((value, index) => index % 4 !== 3 && value > 200);
            }),
        { timeout: 30_000 },
      )
      .toBe(true);
    await capture(page, 'computer', true);
  }
  const common: Array<[string, string, boolean?]> = [
    ['knowledge', `/#/knowledge/${doc.id}`, true],
    ['knowledge-edit', `/#/knowledge/${doc.id}?edit=1`],
    ['tables', `/#/tables/${base.id}/${table.id}`, true],
    ...base.views
      .filter((view) => view.table_id === table.id)
      .map((view): [string, string] => [`table-${view.type}`, `/#/tables/${base.id}/${table.id}/${view.id}`]),
    ['apps', `/#/apps/${app.app.id}`, true],
    ['apps-center', '/#/apps'],
    ['app-builder', `/#/apps/${app.app.id}/edit`],
    ['agents', `/#/agents/${agent.id}`, true],
    ...['profile', 'abilities', 'memory', 'schedules', 'computer', 'publish', 'activity'].map(
      (tab): [string, string] => [`agent-${tab}`, `/#/agents/${agent.id}?tab=${tab}`],
    ),
    ['direct', `/#/c/${direct.id}`],
    ['run-detail', `/#/runs/${run.last_run_id}`],
    ['chat', `/#/c/${chat.id}`],
    ['room', `/#/c/${room.id}`, true],
    ['schedules', `/#/agents/${agent.id}?tab=schedules`, true],
    ['connections', '/#/settings/connections', true],
    ['providers', '/#/admin/services', true],
    ...[
      'agents',
      'runs',
      'runs?view=scheduled',
      'runs?view=done',
      'notifications',
      'knowledge',
      'knowledge?space=team',
      'knowledge?space=personal',
      'knowledge?space=shared',
      'tables',
      'skills',
      'skills?scope=mine',
      'skills?scope=review',
      'skills?scope=archived',
      'settings/account',
      'settings/notifications',
      'settings/connections',
      'settings/vault',
      'settings/services',
      'settings/access',
    ].map((path): [string, string] => [path.replace(/[^\w-]+/g, '-'), `/#/${path}`]),
  ];
  for (const who of ['lin', 'mei'] as const) {
    const target = who === 'lin' ? page : await contexts.get(who)!.newPage();
    if (who !== 'lin') target.on('pageerror', (error) => errors.push(error.message));
    const routes =
      who === 'lin'
        ? [
            ...common,
            ...['members', 'services', 'usage', 'connectors', 'access', 'public-agents', 'branding'].map(
              (section): [string, string] => [`admin-${section}`, `/#/admin/${section}`],
            ),
          ]
        : common.filter(
            ([name]) =>
              !['knowledge-edit', 'app-builder'].includes(name) &&
              !name.startsWith('agent-') &&
              !['agents', 'direct', 'chat'].includes(name),
          );
    for (const [name, route, publish] of routes) {
      await target.goto(origin + route);
      console.log(`${who}: ${name}`);
      await expect(target.locator('.app-page-title').first()).toBeVisible();
      await target.locator('.gh-skeleton').first().waitFor({ state: 'hidden' });
      await capture(target, publish && who === 'lin' ? name : `${who}-${name}`, publish && who === 'lin');
    }
    await target.goto(`${origin}/#/c/main`);
    await target.getByRole('textbox', { name: /发消息|Message/ }).waitFor();
    await target.keyboard.press('ControlOrMeta+k');
    await capture(target, `${who}-command`);
    await target.keyboard.press('Escape');
    await target.keyboard.press('ControlOrMeta+j');
    await target
      .getByRole('dialog')
      .getByRole('textbox', { name: /发消息|Message/ })
      .waitFor();
    await capture(target, `${who}-page-assistant`);
  }
  const signedOut = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  await signedOut.goto(origin);
  await signedOut.getByRole('button', { name: '登录', exact: true }).waitFor();
  await capture(signedOut, 'sign-in');
  await signedOut.goto(`${origin}/#/activate?token=sample-expired-link`);
  await capture(signedOut, 'activation');
  const conversations = await api<{ items: Conversation[] }>('/conversations');
  await writeFile(
    `${review}/capture-manifest.json`,
    JSON.stringify(
      {
        origin,
        sample: {
          base: base.id,
          doc: doc.id,
          app: app.app.id,
          agent: agent.id,
          conversations: conversations.items.map(({ id, kind }) => ({ id, kind })),
        },
        screenshots: results,
      },
      null,
      2,
    ),
  );
  console.log(`Captured ${results.length} review images; published light/dark WebP pairs in ${output}.`);
  if (results.some((item) => item.overflow || (item.unnamed as string[]).length || (item.errors as string[]).length))
    console.log(`Review overflow, unnamed controls and page errors in ${review}/capture-manifest.json.`);
} finally {
  await writeFile(`${review}/capture-results.json`, JSON.stringify(results, null, 2));
  await browser.close();
}
