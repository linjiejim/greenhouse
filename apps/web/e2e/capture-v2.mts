/** Publish focused, 2× product captures from a freshly seeded local stack. Requires cwebp. */
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect, type Locator } from '@playwright/test';
import type { AgentDetail, AppDraft, Base, Field, MemberSummary, TokenPair } from '@greenhouse/contract';
import { PEOPLE } from './env.ts';

const origin = `http://127.0.0.1:${process.env.STACK_WEB_PORT ?? 4580}`;
const output = process.env.SCREENSHOT_DIR ?? 'docs/assets/v2';
const review = process.env.SCREENSHOT_REVIEW_DIR ?? 'artifacts/t10/after';
const fixture = process.env.FAKE_LLM_CAPTURE_FIXTURE;
if (!fixture)
  throw new Error('Set FAKE_LLM_CAPTURE_FIXTURE to the same local JSON path for stack.sh and this capture.');
await mkdir(output, { recursive: true });
await mkdir(review, { recursive: true });
await expect
  .poll(
    async () => {
      try {
        return (await fetch(`${origin}/api/bootstrap`)).status;
      } catch {
        return 0;
      }
    },
    { timeout: 30000 },
  )
  .toBe(200);
const browser = await chromium.launch();
const results: Array<Record<string, unknown>> = [];
const errors: string[] = [];
try {
  const contexts = new Map<string, Awaited<ReturnType<typeof browser.newContext>>>();
  for (const who of ['lin', 'mei'] as const) {
    const context = await browser.newContext({
      locale: 'zh-CN',
      timezoneId: 'Asia/Taipei',
      deviceScaleFactor: 2,
      viewport: { width: 1440, height: 900 },
    });
    context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
    const response = await context.request.post(`${origin}/api/auth/login`, {
      data: { email: PEOPLE[who].email, password: PEOPLE[who].password, client: 'web' },
    });
    if (!response.ok()) throw new Error(`Sample sign-in: ${response.status()}`);
    const tokens = (await response.json()) as TokenPair;
    await context.setExtraHTTPHeaders({ authorization: `Bearer ${tokens.access_token}` });
    await context.addInitScript(
      ({ tokens, origin }) => {
        if (window === window.top && globalThis.origin === origin)
          localStorage.setItem('greenhouse.session', JSON.stringify(tokens));
      },
      { tokens, origin },
    );
    contexts.set(who, context);
  }
  const lin = contexts.get('lin')!;
  async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
    const response = await lin.request.fetch(`${origin}/api${path}`, {
      method,
      ...(data === undefined ? {} : { data }),
    });
    if (!response.ok()) throw new Error(`${method} ${path}: ${response.status()} ${await response.text()}`);
    return (response.status() === 204 ? {} : await response.json()) as T;
  }
  const providers = await api<{
    capabilities: Array<{
      capability: string;
      instances: Array<{ id: string; source: string; config: Record<string, unknown> }>;
    }>;
  }>('/admin/providers');
  const models = providers.capabilities.find((entry) => entry.capability === 'llm')?.instances ?? [];
  if (
    !models.length ||
    models.some((entry) => !['127.0.0.1', 'localhost'].includes(new URL(String(entry.config.baseUrl)).hostname))
  )
    throw new Error('Use the local fake-model stack; refusing a remote model.');
  const fake = new URL(String(models[0]!.config.baseUrl)).origin;
  for (const [capability, name] of [
    ['llm', '工作模型'],
    ['sandbox', '隔离电脑'],
    ['search', '网页搜索'],
    ['storage', '本地文件'],
  ]) {
    const instance = providers.capabilities
      .find((entry) => entry.capability === capability)
      ?.instances.find((entry) => entry.source === 'env');
    if (!instance) continue;
    const copy = await api<{ id: string }>(`/admin/providers/${instance.id}/copy`, 'POST');
    await api(`/admin/providers/${copy.id}`, 'PATCH', { name });
  }
  const people = await api<{ items: MemberSummary[] }>('/members');
  const mei = people.items.find((person) => person.name === 'Mei')!;
  const me = people.items.find((person) => person.name === 'Lin')!;
  await api('/me', 'PATCH', { timezone: 'Asia/Taipei' });
  const main = await api<AgentDetail>('/agents/main');
  await api(`/agents/${main.id}`, 'PATCH', {
    role: '发布进展、资料整理与日常协作',
    description: '每天一起推进秋季版本发布，保留决定和出处。',
  });
  const folder = await api<{ id: string }>('/knowledge/folders', 'POST', { name: '发布准备', space: 'team' });
  const content =
    '# 秋季版本发布计划\n\n10 月 23 日发布，让新成员更快完成第一次协作。\n\n## 这周先把三件事做好\n\n- [x] 邀请流程与权限检查 — Lin\n- [x] 首次使用指南与截图 — Mei\n- [ ] 发布说明与客户邮件 — 周四定稿\n\n## 发布当天\n\n08:00 检查服务与备份，10:00 发布新版本。成员确认后再发送客户邮件。\n\n## 今天的决定\n\n先面向已有成员开放，新成员邀请在下周一开启。体验反馈统一记入发布看板。';
  const doc = await api<{ id: string }>('/knowledge/docs', 'POST', {
    title: '秋季版本发布计划',
    folder_id: folder.id,
    space: 'team',
    content,
  });
  await api(`/knowledge/docs/${doc.id}/comments`, 'POST', {
    body: '首次使用指南已更新，我会在周四补齐最后一轮体验反馈。',
  });
  let base = await api<Base>('/tables/bases', 'POST', {
    name: '秋季版本发布',
    description: '把发布前的每一步，交到明确的人手里。',
  });
  if (!base.tables.length) await api(`/tables/bases/${base.id}/tables`, 'POST', { name: '发布清单' });
  base = await api<Base>(`/tables/bases/${base.id}`);
  const table = base.tables[0]!;
  await api(`/tables/tables/${table.id}`, 'PATCH', { name: '发布清单' });
  const title = table.fields.find((field) => field.is_primary)!;
  const status = await api<Field>(`/tables/tables/${table.id}/fields`, 'POST', {
    name: '进展',
    type: 'single_select',
    config: {
      options: [
        { id: 'done', label: '已完成', color: 'green' },
        { id: 'doing', label: '进行中', color: 'blue' },
        { id: 'waiting', label: '待确认', color: 'amber' },
      ],
    },
  });
  const owner = await api<Field>(`/tables/tables/${table.id}/fields`, 'POST', { name: '负责人', type: 'member' });
  const date = await api<Field>(`/tables/tables/${table.id}/fields`, 'POST', { name: '截止日期', type: 'date' });
  for (const [name, state, member, day] of [
    ['邀请流程与权限检查', 'done', me.id, '2026-10-19'],
    ['首次使用指南', 'done', mei.id, '2026-10-20'],
    ['发布说明与截图', 'doing', mei.id, '2026-10-22'],
    ['客户邮件确认', 'waiting', me.id, '2026-10-22'],
    ['发布当天服务检查', 'waiting', me.id, '2026-10-23'],
  ])
    await api(`/tables/tables/${table.id}/records`, 'POST', {
      values: { [title.id]: name, [status.id]: state, [owner.id]: [member], [date.id]: day },
    });
  let app = await api<AppDraft>('/apps', 'POST', {
    base_id: base.id,
    name: '发布工作台',
    description: '打开就能看到这周该做的事。',
  });
  app = await api<AppDraft>(`/apps/${app.app.id}/draft`, 'PUT', {
    revision: app.revision,
    name: app.app.name,
    description: app.app.description,
    spec: {
      pages: [
        {
          id: 'home',
          name: '发布清单',
          cards: [
            {
              id: 'tasks',
              kind: 'records',
              title: '发布前，一起把这几件事做好',
              table_id: table.id,
              fields: [title.id, status.id, owner.id, date.id],
              filter: { mode: 'and', clauses: [{ field: status.id, op: 'eq', value: 'doing' }] },
              actions: [],
            },
          ],
        },
      ],
      roles: [{ id: 'reader', name: '成员', rules: { tables: { [table.id]: { access: 'read' } } } }],
    },
  });
  await api(`/apps/${app.app.id}/publish`, 'POST', {
    revision: app.revision,
    audience: [{ principal_type: 'workspace', principal_id: null, role: 'reader' }],
  });
  for (const [name, role, plant] of [
    ['发布搭档', '梳理发布清单，跟进每个决定', 'sakura'],
    ['晨间邮件', '整理来信，只提醒值得关注的事', 'sunflower'],
  ])
    await api('/agents', 'POST', {
      name,
      role,
      description: role,
      avatar: { plant },
      instructions: '用简短中文给出结果，保留出处。',
    });
  const schedule = await api<{ id: string }>('/schedules', 'POST', {
    agent_id: main.id,
    name: '晨间发布进展',
    brief: '查看发布清单和昨晚的来信，整理今天需要跟进的事。没有新进展就保持安静。',
    cron: '0 8 * * *',
    timezone: 'Asia/Taipei',
    quiet: true,
  });
  for (const [slug, name, description] of [
    ['product-repo', '产品代码库', '查看发布变更与合并记录'],
    ['customer-feedback', '客户反馈', '汇总试用成员提出的建议'],
  ]) {
    const connector = await api<{ id: string }>('/admin/connectors', 'POST', {
      slug,
      name,
      description,
      url: `${fake}/mcp/key`,
      transport: 'streamable_http',
      auth_mode: 'per_member',
      auth_header: 'X-Api-Key',
    });
    await api('/me/connections', 'POST', { connector_id: connector.id, key: 'e2e-good-key' });
  }
  const mailSecret = 'whsec_' + Buffer.from('launch-capture-not-a-real-secret').toString('base64');
  const mailProvider = await api<{ id: string }>('/admin/providers', 'POST', {
    capability: 'mail',
    kind: 'resend',
    name: '发布邮件',
    config: { baseUrl: `${fake}/resend`, fromAddress: 'release@example.com', fromName: '发布协作' },
    secrets: { apiKey: 're_e2e_0123456789', webhookSecret: mailSecret },
  });
  await api('/admin/provider-bindings/mail', 'PUT', { instance_ids: [mailProvider.id] });
  await api('/admin/mail', 'PUT', { agent_domain: 'agents.example.com' });
  const mailbox = await api<{ address: string }>('/agents/main/mailbox');
  const inbound = await lin.request.post(`${fake}/resend/_inbound`, {
    data: {
      from: '设计协作 <design@example.com>',
      to: [mailbox.address],
      subject: '秋季版本：首次使用指南已定稿',
      text: '邀请流程和截图都已更新。请在周四的发布回顾中一起确认，客户邮件等 Lin 点头后再发。',
    },
  });
  const received = (await inbound.json()) as { id: string };
  const body = JSON.stringify({
    type: 'email.received',
    created_at: new Date().toISOString(),
    data: { email_id: received.id },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const notice = 'launch-capture';
  const signature = createHmac('sha256', Buffer.from(mailSecret.slice(6), 'base64'))
    .update(`${notice}.${timestamp}.${body}`)
    .digest('base64');
  // Unknown sender mail stays held for review; no background reply is invented.
  const mailResponse = await lin.request.post(`${origin}/api/mail/inbound/${mailProvider.id}`, {
    headers: {
      'content-type': 'application/json',
      'svix-id': notice,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`,
    },
    data: body,
  });
  if (!mailResponse.ok()) throw new Error(`Sample mail: ${mailResponse.status()}`);
  await expect
    .poll(async () =>
      (await api<{ items: Array<{ subject: string }> }>('/agents/main/mail')).items.map((mail) => mail.subject),
    )
    .toContain('秋季版本：首次使用指南已定稿');
  await writeFile(
    fixture,
    JSON.stringify(
      {
        replies: [
          {
            prompt: '这周的发布准备得怎么样了',
            tool: { name: 'knowledge_query', arguments: { action: 'search', query: '秋季版本发布计划' } },
            text: `发布定在下周五。邀请流程和首次使用指南已经准备好，还剩发布说明与客户邮件需要周四定稿。\n\n我把负责人与日期都留在了[秋季版本发布计划](#/knowledge/${doc.id})里。`,
          },
          {
            prompt: '记住发布前要先确认客户邮件',
            tool: {
              name: 'memory',
              arguments: { action: 'remember', title: '发布前先由 Lin 确认客户邮件', category: 'procedure' },
            },
            text: '记住了。客户邮件会等你确认后再发送。',
          },
          {
            prompt: '把发布检查清单放进共享的发布准备',
            tool: {
              name: 'knowledge_mutation',
              arguments: {
                action: 'create',
                title: '发布检查清单',
                folder_id: folder.id,
                content: '# 发布检查清单\n\n- 确认邀请流程与权限\n- 更新发布说明和截图\n- 由 Lin 确认客户邮件后发送',
              },
            },
            text: '发布检查清单已放进共享的「发布准备」，大家可以一起补充。',
          },
          {
            prompt: '今天还有哪些事需要我们一起确认',
            text: '邀请流程已经检查完，Mei 的首次使用指南也已定稿。今天只需要一起确认发布说明和客户邮件；邮件等 Lin 点头后再发。',
          },
          {
            prompt: '首次使用指南已定稿',
            text: '首次使用指南已定稿。周四回顾时一起确认发布说明，客户邮件会等你点头后再发。',
          },
        ],
      },
      null,
      2,
    ),
  );
  const room = await api<{ id: string }>('/conversations', 'POST', {
    kind: 'room',
    title: '秋季版本发布室',
    member_ids: [mei.id],
    agent_ids: [main.id],
  });
  let page = await lin.newPage();
  async function open(route: string, width = 440) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin + route);
    await expect(page.locator('.app-page-title').first()).toBeVisible();
    await page.locator('.gh-skeleton').first().waitFor({ state: 'hidden' });
  }
  async function send(text: string) {
    const response = page.waitForResponse((r) => r.url().includes('/messages') && r.request().method() === 'POST');
    const composer = page.getByRole('textbox', { name: /发消息|Message/ });
    await composer.fill(text);
    await composer.press('Enter');
    await response;
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeHidden();
  }
  async function capture(name: string, target: Locator | null) {
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      const path = `${review}/${name}-${theme}.png`;
      if (target) await target.screenshot({ path, animations: 'disabled' });
      else await page.screenshot({ path, animations: 'disabled' });
      const text = target ? await target.innerText() : await page.locator('main').innerText();
      if (/Echo:|Done\.|Shared agent draft|\b(?:fld|doc|cnv|agt)_[0-9A-Z]{26}\b|This week|E2E/.test(text))
        throw new Error(`Placeholder content in ${name}`);
      const dimensions = target ? await target.boundingBox() : { width: 1440, height: 900 };
      execFileSync('cwebp', ['-quiet', '-q', '84', path, '-o', `${output}/${name}-${theme}.webp`]);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      if (errors.length) throw new Error(`Page error in ${name}: ${errors.join('; ')}`);
      results.push({ name, theme, path, deviceScaleFactor: 2, dimensions, overflow, errors: [...errors], text });
      errors.length = 0;
      console.log(`Captured ${name}/${theme}: ${Math.round(dimensions!.width)} CSS px at 2×`);
      if (overflow) throw new Error(`Overflow in ${name}`);
    }
  }
  await open('/#/c/main', 1440);
  await send('这周的发布准备得怎么样了？');
  await expect(page.getByRole('button', { name: '查看来源：秋季版本发布计划' })).toBeVisible();
  await capture('conversation', null);
  await open('/#/c/main');
  await send('记住发布前要先确认客户邮件。');
  await expect(page.getByRole('button', { name: '撤销这次写入' })).toBeVisible();
  await capture('receipt', page.locator('.app-write-receipt').last());
  await send('把发布检查清单放进共享的发布准备。');
  await expect(page.getByRole('button', { name: '批准', exact: true })).toBeVisible();
  await capture(
    'approval',
    page.locator('.gh-chat-card').filter({ has: page.getByRole('button', { name: '批准', exact: true }) }),
  );
  await open('/#/agents');
  await expect(page.locator('.app-agent-card')).toHaveCount(3);
  await capture('agents', page.locator('.app-card-grid'));
  await open('/#/agents/main?tab=schedules');
  await expect(page.getByText('每天 08:00', { exact: false })).toBeVisible();
  await capture('schedules', page.getByRole('region', { name: '定时' }));
  await open(`/#/knowledge/${doc.id}`);
  await capture('knowledge', page.locator('.app-doc-content').first());
  await open(`/#/tables/${base.id}/${table.id}`, 1440);
  await expect(page.getByText('发布说明与截图', { exact: true })).toBeVisible();
  await capture('tables', null);
  await open(`/#/apps/${app.app.id}`);
  await expect(page.getByText('发布说明与截图', { exact: true })).toBeVisible();
  await capture('apps', page.locator('.app-ap-tile'));
  const other = await contexts.get('mei')!.newPage();
  await other.goto(`${origin}/#/c/${room.id}`);
  const meiComposer = other.getByRole('textbox', { name: /发消息|Message/ });
  await meiComposer.fill('首次使用指南和截图都定稿了，发布说明还需要 Lin 看一下。');
  await meiComposer.press('Enter');
  await expect(
    other.getByText('首次使用指南和截图都定稿了，发布说明还需要 Lin 看一下。', { exact: true }),
  ).toBeVisible();
  await open(`/#/c/${room.id}`);
  const composer = page.getByRole('textbox', { name: /发消息|Message/ });
  await composer.fill('@');
  await page.getByRole('option', { name: /Greeny/ }).click();
  await composer.pressSequentially('今天还有哪些事需要我们一起确认？');
  await composer.press('Enter');
  await expect(page.locator('.app-message').filter({ hasText: '邀请流程已经检查完' })).toBeVisible();
  // Mei's real view includes the Agent owner's name above the reply.
  await page.close();
  page = other;
  await open(`/#/c/${room.id}`);
  await expect(page.getByText('Greeny · Lin', { exact: true })).toBeVisible();
  await capture('room', page.locator('.app-thread-column'));
  await page.close();
  page = await lin.newPage();
  await open('/#/settings/connections');
  await capture('connections', page.locator('.app-section').first());
  await open('/#/admin/services');
  await capture('providers', page.locator('.app-list.app-bordered').first());
  if (process.env.SCREENSHOT_COMPUTER === '1') {
    await api(`/agents/${main.id}/computer/start`, 'POST');
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto(`${origin}/#/agents/main?tab=computer`);
    await expect(page.getByRole('button', { name: '关机', exact: true })).toBeVisible({ timeout: 120000 });
    const name = `gh-cmp-${main.id.toLowerCase()}`;
    const preview = `${review}/launch-preview.html`;
    await writeFile(
      preview,
      '<!doctype html><meta charset="utf-8"><title>秋季版本 · 发布检查</title><style>body{margin:0;background:#f7f8f4;color:#223d32;font:20px/1.7 sans-serif}main{max-width:800px;margin:50px auto;padding:36px;background:white;border-radius:20px}small{color:#6b8175}h1{font-size:36px}li{padding:12px 0;border-bottom:1px solid #e6ebe7}.done{color:#418461}</style><main><small>发布准备 / 10 月 23 日</small><h1>每一步，都准备好了再发布。</h1><p>秋季版本的最后一轮检查</p><ul><li class="done">✓ 邀请流程与权限检查</li><li class="done">✓ 首次使用指南与截图</li><li>发布说明 · Mei 正在整理</li><li>客户邮件 · 等待 Lin 确认</li></ul><small>先确认，再发送。保留每个决定。</small></main>',
    );
    execFileSync('docker', ['exec', name, 'mkdir', '-p', '/home/browser/launch-preview']);
    execFileSync('docker', ['cp', preview, `${name}:/home/browser/launch-preview/index.html`]);
    execFileSync('docker', [
      'exec',
      '-d',
      name,
      'python3',
      '-m',
      'http.server',
      '4972',
      '--bind',
      '127.0.0.1',
      '--directory',
      '/home/browser/launch-preview',
    ]);
    execFileSync('docker', ['exec', name, 'gh-window', 'restore']);
    execFileSync('docker', ['exec', name, 'xdotool', 'key', 'ctrl+l']);
    execFileSync('docker', ['exec', name, 'xdotool', 'type', '--clearmodifiers', 'http://127.0.0.1:4972/']);
    execFileSync('docker', ['exec', name, 'xdotool', 'key', 'Return']);
    await expect
      .poll(
        () =>
          execFileSync('docker', ['exec', name, 'xdotool', 'getactivewindow', 'getwindowname'], { encoding: 'utf8' }),
        { timeout: 30000 },
      )
      .toContain('秋季版本');
    await expect
      .poll(
        () =>
          page
            .locator('canvas')
            .first()
            .evaluate((canvas: HTMLCanvasElement) =>
              canvas
                .getContext('2d')!
                .getImageData(0, 0, canvas.width, canvas.height)
                .data.some((value, index) => index % 4 !== 3 && value > 200),
            ),
        { timeout: 30000 },
      )
      .toBe(true);
    await capture('computer', page.getByRole('region', { name: '电脑', exact: true }));
  }
  await writeFile(
    `${review}/capture-manifest.json`,
    JSON.stringify(
      {
        origin,
        sample: { base: base.id, doc: doc.id, app: app.app.id, agent: main.id, room: room.id, schedule: schedule.id },
        screenshots: results,
      },
      null,
      2,
    ),
  );
  console.log(`Published ${results.length} focused 2× captures.`);
} finally {
  await writeFile(`${review}/capture-results.json`, JSON.stringify(results, null, 2));
  await browser.close();
}
