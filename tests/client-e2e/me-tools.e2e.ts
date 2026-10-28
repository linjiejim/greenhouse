import { test, expect, type Page } from '@playwright/test';
import { installPlaces, officialManifest } from './p3-fixture';

// The classic screens ported to the universal client: gateway keys, the agent-connection guide,
// my own connectors, my activity, skill upload and history, and report-template editing.
const at = '2026-10-28T09:00:00Z';
const shots = '.work/power';

async function station(page: Page) {
  await installPlaces(page);
  const writes: { method: string; path: string; body: any }[] = [];
  const exports: string[] = [];
  const key = (id: string, name: string, status: 'active' | 'revoked' = 'active') => ({
    id,
    name,
    prefix: `ghgw_${id}`,
    allowed_models: null,
    expires_at: null,
    last_used_at: null,
    revoked_at: status === 'revoked' ? at : null,
    created_at: at,
    status,
    month_spend_usd_micros: 1_250_000,
    month_calls: 12,
  });
  const keys = [key('k1', '笔记本上的 Cursor')];
  const personal: any[] = [];
  const skill = {
    name: 'weekly-report',
    display_name: '周报',
    description: '按团队模板写周报',
    tags: ['report'],
    latest_version: '1.0.0',
    status: 'active',
    owner_user_id: 'member',
    download_count: 3,
    scan_status: 'clean',
    source_group: null,
    created_at: at,
    updated_at: at,
  };
  const skills: any[] = [skill];
  const versions: Record<string, any[]> = {
    'weekly-report': [
      {
        version: '1.0.0',
        changelog: '第一版',
        file_count: 1,
        size_bytes: 512,
        content_hash: 'h1',
        created_by: 'member',
        created_at: at,
      },
    ],
  };
  const template = (id: string, name: string) => ({
    id,
    name,
    description: '每周的渠道与库存',
    kind: 'report',
    formats: ['pdf', 'docx'],
    sections: [{ key: 'summary', title: '摘要', guidance: '三句话', required: true, content: 'markdown' }],
    cover_fields: [{ key: 'title', required: true }],
    visibility: 'team',
    owner_user_id: 'member',
    owner_name: 'Jim Lin',
    version: 1,
    is_default: false,
    created_at: at,
    updated_at: at,
    can_edit: true,
  });
  const templates: any[] = [template('tpl-1', '周报模板')];
  const manifest = officialManifest() as any;
  for (const [id, zh] of [
    ['skills', '技能'],
    ['reports', '报告模板'],
  ])
    manifest.plugins.push({
      id,
      name: { en: id, zh },
      version: '4.0.0',
      official: true,
      description: null,
      features: [],
      mcp_groups: [],
      entity_kinds: [],
      entities: [],
      nav: [{ id, label: { zh, en: id }, page: id, icon: 'Sparkles', placement: 'more' }],
      pages: [{ id, title: { zh, en: id }, kind: 'native', screen: id }],
    });

  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      method = req.method();
    const body = ['POST', 'PATCH', 'PUT'].includes(method) && req.postData() ? req.postDataJSON() : null;
    const json = (value: unknown, status = 200) => route.fulfill({ json: value, status });
    if (!['GET', 'OPTIONS'].includes(method)) writes.push({ method, path, body });
    if (path === '/api/extensions') return json(manifest);
    // My Agents and the connect guide
    if (path === '/api/agent-access/writes') return json({ writes: [] });
    if (path === '/api/usage/spend')
      return json({
        period: { start: at, end: at },
        totals: { cost_usd_micros: 2_500_000, calls: 20, unpriced_calls: 0 },
        by_service: [],
        by_client: [],
        budget: {
          limit_usd_micros: 50_000_000,
          spent_usd_micros: 2_500_000,
          reserved_usd_micros: 0,
          source: 'default',
        },
      });
    if (path === '/api/agent-access/gateway')
      return json({
        enabled: true,
        base_url: 'https://station.test/api/gateway/v1',
        anthropic_base_url: 'https://station.test/api/gateway/anthropic',
        models: [{ id: 'claude-sonnet', name: 'Claude Sonnet', openai: true, anthropic: true }],
        keys,
      });
    if (path === '/api/agent-access/gateway/keys' && method === 'POST') {
      keys.unshift(key('k2', body.name));
      return json({ key: keys[0], secret: 'ghgw_k2_secret-shown-once' }, 201);
    }
    if (path.startsWith('/api/agent-access/gateway/keys/') && method === 'DELETE') {
      const found = keys.find((k) => k.id === path.split('/').at(-1))!;
      Object.assign(found, { status: 'revoked', revoked_at: at });
      return json({ ok: true, key: found });
    }
    if (path === '/api/agent-access/overview') return json({ mcp_url: 'https://station.test/api/mcp' });
    if (path === '/api/agent-access/connections')
      return json({
        now: new Date().toISOString(),
        connections: [
          {
            client_id: 'c1',
            client_name: 'Claude Code',
            kind: 'claude-code',
            last_seen_at: new Date(Date.now() - 60_000).toISOString(),
            connected_at: at,
          },
        ],
      });
    // My connectors
    if (path === '/api/me/connectors') return json({ team: [], personal });
    if (path === '/api/me/connectors/personal' && method === 'POST') {
      const created = {
        id: 'pc-1',
        scope: 'personal',
        handle: `me/${body.slug}`,
        status: body.auth_mode === 'per_member' ? 'not_connected' : 'not_needed',
        last_error: null,
        oauth_client: null,
        tools: [],
        ...body,
      };
      personal.push(created);
      return json(created, 201);
    }
    if (path === '/api/me/connectors/personal/pc-1/refresh')
      return json({
        ok: true,
        error: null,
        connector: { ...personal[0], tools: [{ name: 'search' }, { name: 'read' }] },
      });
    if (path === '/api/me/connectors/personal/pc-1' && method === 'DELETE') {
      personal.splice(0, 1);
      return json({ ok: true });
    }
    // My activity
    if (path === '/api/activity')
      return json({
        items: [
          {
            id: 'a1',
            source: url.searchParams.get('source') ?? 'person',
            at,
            actor: { id: 'member', name: 'Jim Lin' },
            agent: null,
            module: 'knowledge',
            verb: 'updated',
            entity: 'kb_doc',
            action: 'update',
            action_title: '更新政策',
            target: { id: 'doc-x', label: '远程办公政策', url: null },
            run: null,
            detail: null,
          },
        ],
        next_cursor: null,
      });
    if (path === '/api/activity/export') {
      exports.push(url.search);
      return route.fulfill({ body: 'at,actor\n', contentType: 'text/csv' });
    }
    // Skills
    if (path === '/api/skills') return json({ total: skills.length, skills });
    if (path.startsWith('/api/skills/') && method === 'GET' && path !== '/api/skills/publish') {
      const name = decodeURIComponent(path.split('/').at(-1)!);
      return json({ skill: skills.find((s) => s.name === name), versions: versions[name] ?? [] });
    }
    if (path === '/api/skills/publish') {
      const existing = skills.find((s) => s.name === body.name);
      const version = {
        version: body.version ?? '1.0.1',
        changelog: body.changelog ?? '',
        file_count: body.files.length,
        size_bytes: 600,
        content_hash: 'h2',
        created_by: 'member',
        created_at: at,
      };
      const row = existing ?? { ...skill, name: body.name, display_name: body.display_name ?? body.name };
      if (!existing) skills.push(row);
      row.latest_version = version.version;
      versions[body.name] = [version, ...(versions[body.name] ?? [])];
      return json({ created: !existing, skill: row, version }, existing ? 200 : 201);
    }
    // Report templates
    if (path === '/api/report-templates' && method === 'GET') return json({ templates });
    if (path === '/api/report-templates' && method === 'POST') {
      const created = { ...template('tpl-2', body.name), ...body };
      templates.push(created);
      return json({ template: created }, 201);
    }
    if (path.startsWith('/api/report-templates/tpl-')) {
      const index = templates.findIndex((tpl) => tpl.id === path.split('/').at(-1));
      if (method === 'PUT') {
        Object.assign(templates[index], body);
        return json({ template: templates[index] });
      }
      if (method === 'DELETE') {
        const [gone] = templates.splice(index, 1);
        return json({ deleted: true, id: gone.id });
      }
    }
    return route.fallback();
  });
  return { writes, exports, keys, personal, templates, versions };
}

async function ready(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByTestId('startup-splash')).toHaveCount(0);
}

test.use({ viewport: { width: 1440, height: 900 } });

test('My Agents creates a gateway key, shows its secret once, and revokes a key', async ({ page }) => {
  const f = await station(page);
  await ready(page, '/me/agents');
  await expect(page.getByText('笔记本上的 Cursor')).toBeVisible();
  await page.getByText('新建密钥', { exact: true }).click();
  await page.getByRole('textbox', { name: '例如：笔记本上的 Cursor' }).fill('终端里的 Codex');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  const secret = page.getByTestId('gateway-secret');
  await expect(secret).toContainText('ghgw_k2_secret-shown-once');
  await expect(secret).toContainText('现在复制“终端里的 Codex”');
  expect(f.writes.find((w) => w.method === 'POST')).toEqual({
    method: 'POST',
    path: '/api/agent-access/gateway/keys',
    body: { name: '终端里的 Codex' },
  });
  await page.screenshot({ path: `${shots}/gateway-secret.png` });
  await secret.getByText('我已复制').click();
  await expect(page.getByTestId('gateway-secret')).toHaveCount(0);
  await expect(page.getByText('ghgw_k2_secret-shown-once')).toHaveCount(0);

  await page.getByTestId('gateway-key-k1').click();
  await page.getByRole('menuitem', { name: '吊销' }).click();
  await page.getByRole('button', { name: '吊销', exact: true }).click();
  await expect.poll(() => f.writes.find((w) => w.method === 'DELETE')?.path).toBe('/api/agent-access/gateway/keys/k1');
  await expect(page.getByTestId('gateway-key-k1')).toHaveCount(0);
});

test('The connect guide shows each client its setup and checks the connection', async ({ page }) => {
  await station(page);
  await ready(page, '/me/agents');
  await page.getByText('连接 Agent', { exact: true }).click();
  await expect(page).toHaveURL(/\/me\/connect$/);
  await page.getByLabel('Claude Code', { exact: true }).click();
  const setup = page.getByTestId('connect-setup');
  await expect(setup).toContainText('https://station.test/api/mcp');
  await expect(setup).toContainText('claude mcp add --transport http greenhouse https://station.test/api/mcp');
  await expect(
    page.getByText('ANTHROPIC_BASE_URL=https://station.test/api/gateway/anthropic', { exact: false }),
  ).toBeVisible();
  await page.getByText('检查连接', { exact: true }).click();
  await expect(page.getByText(/Claude Code .*访问过工作站，已经连上了/)).toBeVisible();
  await page.screenshot({ path: `${shots}/connect-guide.png`, fullPage: true });

  await page.getByLabel('Cursor', { exact: true }).click();
  await expect(setup).toContainText('"mcpServers"');
  await page.getByText('检查连接', { exact: true }).click();
  await expect(page.getByText('这个 Agent 还没有连接。完成第 2 步的登录后再检查。')).toBeVisible();
  await page.getByLabel('Codex', { exact: true }).click();
  await expect(page.getByText(/Codex 不能使用网关/)).toBeVisible();
});

test('A member adds, refreshes and deletes a connector of their own', async ({ page }) => {
  const f = await station(page);
  await ready(page, '/me/connectors');
  await page.getByText('添加连接器', { exact: true }).click();
  const form = page.getByTestId('personal-connector-form');
  await form.getByLabel('名称').fill('我的笔记');
  await form.getByLabel('标识').fill('Notes');
  await form.getByLabel('MCP 地址').fill('https://notes.example.com/mcp');
  await form.getByLabel('需要').selectOption('key');
  await page.screenshot({ path: `${shots}/personal-connector-form.png` });
  await form.getByRole('button', { name: '添加连接器', exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(f.writes.find((w) => w.path === '/api/me/connectors/personal')?.body).toEqual({
    slug: 'notes',
    name: '我的笔记',
    description: null,
    url: 'https://notes.example.com/mcp',
    transport: 'streamable_http',
    auth_mode: 'per_member',
    auth_kind: 'key',
    auth_header: 'Authorization',
    auth_query_param: null,
    auth_value_prefix: 'Bearer ',
    oauth_scope: null,
    oauth_client_id: null,
  });
  const row = page.getByTestId('own-connector-notes');
  await expect(row).toContainText('我的笔记');

  await row.click();
  await page.getByRole('menuitem', { name: '刷新工具' }).click();
  await expect(page.getByText('列出了 2 个工具')).toBeVisible();

  await row.click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByTestId('own-connector-notes')).toHaveCount(0);
  expect(f.writes.some((w) => w.method === 'DELETE' && w.path === '/api/me/connectors/personal/pc-1')).toBe(true);
});

test('My activity lists my changes, filters them and exports the same rows as CSV', async ({ page }) => {
  const f = await station(page);
  const asked: URLSearchParams[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname === '/api/activity') asked.push(url.searchParams);
  });
  await ready(page, '/me');
  await page.getByText('我的动态', { exact: true }).first().click();
  await expect(page).toHaveURL(/\/me\/activity$/);
  await expect(page.getByText('远程办公政策').first()).toBeVisible();
  await page.getByText('我的 Agent', { exact: true }).last().click();
  await expect.poll(() => asked.at(-1)?.get('source')).toBe('agent');
  await page.screenshot({ path: `${shots}/my-activity.png` });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV' }).click();
  expect((await download).suggestedFilename()).toBe('activity.csv');
  expect(new URLSearchParams(f.exports[0]).get('source')).toBe('agent');
  expect(new URLSearchParams(f.exports[0]).get('from')).toBe(asked.at(-1)?.get('from'));
});

test('Skills: upload a folder as a new skill, then publish a new version from its history', async ({ page }) => {
  const f = await station(page);
  await ready(page, '/p/skills/skills');
  await expect(page.getByTestId('skills-list')).toContainText('周报');
  await page.getByTestId('skill-upload').click();
  const form = page.getByTestId('skill-upload-form');
  await form.getByTestId('skill-files').setInputFiles([
    {
      name: 'SKILL.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('---\nname: churn-review\ndescription: 复盘流失客户\n---\n# 流失复盘\n\n按步骤复盘。\n'),
    },
    { name: 'checklist.md', mimeType: 'text/markdown', buffer: Buffer.from('- 看最近一次沟通\n') },
  ]);
  await expect(form.getByTestId('skill-picked')).toContainText('2 个文件');
  await expect(form.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('churn-review');
  await expect(form.getByLabel('显示名称')).toHaveValue('流失复盘');
  await page.screenshot({ path: `${shots}/skill-upload.png` });
  await form.getByRole('button', { name: '发布', exact: true }).click();
  await expect.poll(() => f.writes.find((w) => w.path === '/api/skills/publish')?.body?.name).toBe('churn-review');
  const published = f.writes.find((w) => w.path === '/api/skills/publish')!.body;
  expect(published.description).toBe('复盘流失客户');
  expect(published.files.map((file: any) => file.path).sort()).toEqual(['SKILL.md', 'checklist.md']);

  // the version history of an existing skill, and a new version that needs a changelog
  await page.keyboard.press('Escape');
  await page.getByTestId('skills-list').getByRole('button', { name: '周报' }).click();
  const detail = page.getByTestId('skill-detail');
  await expect(detail.getByTestId('skill-versions')).toContainText('第一版');
  await detail.getByTestId('skill-new-version').click();
  const next = page.getByTestId('skill-upload-form');
  await next
    .getByTestId('skill-files')
    .setInputFiles([
      { name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from('---\nname: weekly-report\n---\n# 周报\n') },
    ]);
  await expect(next.getByRole('textbox', { name: '版本', exact: true })).toHaveValue('1.0.1');
  await expect(next.getByRole('button', { name: '发布', exact: true })).toBeDisabled();
  await next.getByLabel('更新说明').fill('加上库存一节');
  await next.getByRole('button', { name: '发布', exact: true }).click();
  await expect
    .poll(() => f.writes.filter((w) => w.path === '/api/skills/publish').at(-1)?.body?.changelog)
    .toBe('加上库存一节');
  await expect(page.getByTestId('skill-versions')).toContainText('加上库存一节');
  await page.screenshot({ path: `${shots}/skill-history.png` });
});

test('Report templates: create, edit and delete', async ({ page }) => {
  const f = await station(page);
  await ready(page, '/p/reports/reports');
  await expect(page.getByTestId('templates-list')).toContainText('周报模板');

  await page.getByTestId('template-new').click();
  const editor = page.getByTestId('template-editor');
  await editor.getByRole('button', { name: '创建', exact: true }).click();
  await expect(editor.getByTestId('template-problems')).toBeVisible();
  await editor.getByRole('textbox', { name: '名称', exact: true }).fill('月度经营报告');
  await editor.getByTestId('template-section-0').getByLabel('标题').fill('本月概况');
  await page.screenshot({ path: `${shots}/template-editor.png` });
  await editor.getByRole('button', { name: '创建', exact: true }).click();
  await expect(editor).toHaveCount(0);
  const created = f.writes.find((w) => w.method === 'POST' && w.path === '/api/report-templates')!.body;
  expect(created).toMatchObject({
    name: '月度经营报告',
    kind: 'report',
    visibility: 'team',
    sections: [{ key: 'summary', title: '本月概况', required: true, content: 'markdown' }],
  });
  await expect(page.getByTestId('templates-list')).toContainText('月度经营报告');

  await page.getByTestId('templates-list').getByRole('button', { name: '周报模板' }).click();
  await editor.getByRole('textbox', { name: '名称', exact: true }).fill('周报模板（新版）');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(f.writes.find((w) => w.method === 'PUT')).toMatchObject({
    path: '/api/report-templates/tpl-1',
    body: { name: '周报模板（新版）' },
  });

  await page.getByTestId('templates-list').getByRole('button', { name: '周报模板（新版）' }).click();
  await editor.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).last().click();
  await expect(page.getByTestId('templates-list')).not.toContainText('周报模板（新版）');
  expect(f.writes.some((w) => w.method === 'DELETE' && w.path === '/api/report-templates/tpl-1')).toBe(true);
});
