import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { installPlaces, officialManifest } from './p3-fixture';

// Email, Memory and Computer pages against mocked plugin APIs (plugins/<id>/api routes).
const at = '2026-10-28T09:00:00Z';
const PRESETS = [
  {
    id: 'feishu',
    label: 'Feishu (飞书邮箱)',
    imap_host: 'imap.feishu.cn',
    imap_port: 993,
    smtp_host: 'smtp.feishu.cn',
    smtp_port: 465,
    use_tls: true,
    help_key: 'x',
    help_url: 'https://mail.feishu.cn',
  },
  {
    id: 'gmail',
    label: 'Gmail',
    imap_host: 'imap.gmail.com',
    imap_port: 993,
    smtp_host: 'smtp.gmail.com',
    smtp_port: 465,
    use_tls: true,
    help_key: 'x',
    help_url: 'https://myaccount.google.com/apppasswords',
  },
  {
    id: 'custom',
    label: 'Custom (自定义)',
    imap_host: '',
    imap_port: 993,
    smtp_host: '',
    smtp_port: 465,
    use_tls: true,
    help_key: 'x',
  },
];
const plugin = (id: string, label: string, icon: string) => ({
  id,
  name: id,
  version: '4.0.0',
  official: true,
  description: null,
  features: [],
  mcp_groups: [],
  entity_kinds: [],
  entities: [],
  nav: [{ id, label: { zh: label, en: id }, page: id, icon, placement: 'more', order: 10 }],
  pages: [{ id, title: { zh: label, en: id }, kind: 'native', screen: id }],
});
const memory = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  category: 'preference',
  title,
  content: `${title}：详细说明。`,
  status: 'active',
  pinned: false,
  source: 'agent',
  superseded_by: null,
  last_used_at: at,
  created_at: at,
  updated_at: at,
  ...over,
});

async function appStation(page: Page) {
  const base = await installPlaces(page);
  const writes: { method: string; path: string; body: any }[] = [];
  const manifest = officialManifest() as any;
  manifest.plugins.push(
    plugin('email', '邮件', 'Mail'),
    plugin('memory', '记忆', 'Brain'),
    plugin('computer', '云电脑', 'Monitor'),
  );
  const state = {
    accounts: [] as any[],
    createFails: 1,
    memories: [
      memory('mem_01JB2Y8Z9QW3E4R5T6Y7V8H9P1', '喜欢用表格展示数字', { pinned: true }),
      memory('mem_01JB2Y8Z9QW3E4R5T6Y7V8H9P2', '负责 Q4 新品上线', { category: 'fact' }),
      memory('mem_01JB2Y8Z9QW3E4R5T6Y7V8H9P3', '周会前一天整理周报', { category: 'behavior', status: 'dormant' }),
      memory('mem_01JB2Y8Z9QW3E4R5T6Y7V8H9P4', '旧的报销流程', { status: 'archived' }),
    ] as any[],
    computer: {
      enabled: true,
      configured: true,
      price_per_minute_usd: 0.0021,
      idle_minutes: 15,
      computer: null as any,
      minutes_this_month: 42,
      period: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
    },
    startRefusal: null as null | { status: number; code: string },
  };
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname,
      method = req.method();
    const body = ['POST', 'PUT', 'PATCH'].includes(method) ? (req.postDataJSON() ?? null) : null;
    const json = (value: unknown, status = 200) => route.fulfill({ json: value, status });
    if (path === '/api/extensions') return json(manifest);
    if (
      !path.startsWith('/api/email') &&
      !path.startsWith('/api/auth/me/memories') &&
      !path.startsWith('/api/computer')
    )
      return route.fallback();
    writes.push({ method, path, body });
    if (path === '/api/email/presets') return json({ presets: PRESETS });
    if (path === '/api/email/accounts' && method === 'GET') return json({ accounts: state.accounts });
    if (path === '/api/email/accounts' && method === 'POST') {
      if (state.createFails-- > 0)
        return json(
          {
            error: 'Connection test failed — the account was not saved.',
            test: { imap: { ok: true }, smtp: { ok: false, error: 'Invalid login: 535 Authentication failed' } },
          },
          400,
        );
      const { password: _secret, ...view } = body;
      const account = {
        ...view,
        id: 'ema_01JB2Y8Z9QW3E4R5T6Y7V8H9Q1',
        username: body.username ?? body.email_address,
        status: 'active',
        error_message: null,
        last_verified_at: at,
        created_at: at,
        updated_at: at,
      };
      state.accounts.push(account);
      return json({ account, test: { imap: { ok: true }, smtp: { ok: true } } }, 201);
    }
    const accountId = path.match(/^\/api\/email\/accounts\/([^/]+)/)?.[1];
    if (accountId) {
      const account = state.accounts.find((a) => a.id === accountId);
      if (path.endsWith('/test')) {
        Object.assign(account, { status: 'error', error_message: 'IMAP: Invalid credentials (Failure)' });
        return json({
          account,
          test: { imap: { ok: false, error: 'Invalid credentials (Failure)' }, smtp: { ok: true } },
        });
      }
      if (method === 'PUT') {
        const { password: _secret, ...changes } = body;
        Object.assign(account, changes);
        return json({ account, test: { imap: { ok: true }, smtp: { ok: true } } });
      }
      if (method === 'DELETE') {
        state.accounts = state.accounts.filter((a) => a.id !== accountId);
        return json({ deleted: true, id: accountId });
      }
    }
    if (path === '/api/auth/me/memories') return json({ memories: state.memories });
    const memoryId = path.match(/^\/api\/auth\/me\/memories\/([^/]+)$/)?.[1];
    if (memoryId) {
      if (method === 'DELETE') {
        state.memories = state.memories.filter((m) => m.id !== memoryId);
        return json({ deleted: true });
      }
      const row = state.memories.find((m) => m.id === memoryId);
      Object.assign(row, body);
      return json(row);
    }
    if (path === '/api/computer') return json(state.computer);
    if (path === '/api/computer/start') {
      if (state.startRefusal)
        return json(
          { error: '云电脑已满。All of the team’s computers are in use.', code: state.startRefusal.code },
          state.startRefusal.status,
        );
      state.computer.computer = {
        id: 'mc_01JB2Y8Z9QW3E4R5T6Y7V8H9R1',
        status: 'running',
        started_at: new Date().toISOString(),
        last_used_at: new Date().toISOString(),
        stopped_at: null,
        stop_reason: null,
        minutes_billed: 0,
        client: 'web',
      };
      return json({ computer: state.computer.computer, started: true });
    }
    if (path === '/api/computer/stop') {
      const stopped = state.computer.computer && { ...state.computer.computer, status: 'stopped' };
      state.computer.computer = null;
      return json({ computer: stopped });
    }
    return route.fallback();
  });
  return { ...base, writes, state };
}
async function ready(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByTestId('startup-splash')).toHaveCount(0);
}
async function screenshot(page: Page, name: string) {
  mkdirSync('tests/client-e2e/__screenshots__', { recursive: true });
  await page.screenshot({ path: `tests/client-e2e/__screenshots__/c4-app-${name}.png` });
}

test('Email adds a mailbox through a failed test, edits it without the password, tests and removes it', async ({
  page,
}) => {
  const f = await appStation(page);
  await ready(page, '/p/email/email');
  await expect(page.getByText('还没有邮箱', { exact: true })).toBeVisible();
  await screenshot(page, 'email-empty');
  await page.getByRole('button', { name: '添加邮箱', exact: true }).click();
  const dialog = page.getByTestId('email-account');
  await expect(dialog.getByText('添加邮箱', { exact: true })).toBeVisible();
  await dialog.getByLabel('邮箱服务商').selectOption('gmail');
  await expect(dialog.getByText('先开启两步验证', { exact: false })).toBeVisible();
  await dialog.getByLabel('邮箱地址').fill('jim@example.com');
  await dialog.getByLabel('收件人看到的名字').fill('Jim Work');
  // a missing password is caught before anything is sent
  await dialog.getByRole('button', { name: '测试并保存', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('请填写应用专用密码。');
  expect(f.writes.filter((w) => w.method === 'POST')).toHaveLength(0);
  await dialog.getByLabel('应用专用密码').fill(' abcd efgh ');
  await dialog.getByRole('button', { name: '测试并保存', exact: true }).click();
  // the station's connection test failed: nothing saved, the provider's words shown
  await expect(dialog.getByRole('alert')).toContainText('连接测试没通过');
  await expect(dialog.getByRole('alert')).toContainText('SMTP: Invalid login: 535 Authentication failed');
  await screenshot(page, 'email-test-failed');
  await dialog.getByRole('button', { name: '测试并保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const created = f.writes.filter((w) => w.method === 'POST' && w.path === '/api/email/accounts').at(-1)!.body;
  expect(created).toEqual({
    email_address: 'jim@example.com',
    display_name: 'Jim Work',
    preset: 'gmail',
    imap_host: 'imap.gmail.com',
    imap_port: 993,
    smtp_host: 'smtp.gmail.com',
    smtp_port: 465,
    use_tls: true,
    use_proxy: false,
    password: 'abcd efgh',
  });
  const list = page.getByTestId('email-accounts');
  await expect(list).toContainText('Jim Work');
  await expect(list).toContainText('jim@example.com · imap.gmail.com');
  await expect(list).toContainText('已连接');
  await screenshot(page, 'email-list');

  // edit: the saved password never comes back; an untouched password is not sent
  await list.getByRole('button', { name: 'Jim Work', exact: true }).click();
  await expect(dialog.getByLabel('应用专用密码')).toHaveValue('');
  await expect(dialog.getByLabel('应用专用密码')).toHaveAttribute('placeholder', '留空则保留已保存的密码');
  await expect(dialog.getByLabel('邮箱地址')).toBeDisabled();
  await dialog.getByLabel('收件人看到的名字').fill('Jim');
  await dialog.getByRole('button', { name: '测试并保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(f.writes.find((w) => w.method === 'PUT')?.body).toEqual({ display_name: 'Jim' });

  // test connection from the row's menu: a broken mailbox says so, details behind Details
  await list.getByRole('button', { name: 'Jim 的操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '测试连接', exact: true }).click();
  const alert = page.getByRole('dialog').filter({ hasText: 'jim@example.com 连接不上' });
  await expect(alert).toBeVisible();
  await alert.getByRole('button', { name: '详情' }).click();
  await expect(alert).toContainText('IMAP: Invalid credentials (Failure)');
  await alert.getByRole('button', { name: '好', exact: true }).click();
  await expect(list).toContainText('连接不上');

  // remove after a confirm
  await list.getByRole('button', { name: 'Jim 的操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '移除', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '移除', exact: true }).click();
  await expect(page.getByText('还没有邮箱', { exact: true })).toBeVisible();
  expect(f.writes.some((w) => w.method === 'DELETE' && w.path.startsWith('/api/email/accounts/'))).toBe(true);
  // nothing the client sent back carried a password it had been given
  expect(JSON.stringify(f.writes.filter((w) => w.method !== 'POST'))).not.toContain('abcd efgh');
});

test('Memory groups memories, edits one, pins, archives and deletes; creation stays with the assistant', async ({
  page,
}) => {
  const f = await appStation(page);
  await ready(page, '/p/memory/memory');
  const inUse = page.getByTestId('memory-inUse');
  await expect(inUse).toContainText('喜欢用表格展示数字');
  await expect(inUse).toContainText('偏好');
  await expect(inUse).toContainText('已置顶');
  await expect(page.getByTestId('memory-resting')).toContainText('周会前一天整理周报');
  await expect(page.getByTestId('memory-archived')).toContainText('旧的报销流程');
  await expect(page.getByText('使用中', { exact: true })).toBeVisible();
  await expect(page.getByText('休眠中', { exact: true })).toBeVisible();
  await screenshot(page, 'memory-list');

  await inUse.getByRole('button', { name: '负责 Q4 新品上线', exact: true }).click();
  const dialog = page.getByTestId('memory-edit');
  await expect(dialog.getByLabel('类型')).toHaveValue('fact');
  await dialog.getByLabel(/^标题/).fill('负责 Q4 新品上线和定价');
  await dialog.getByLabel('类型').selectOption('behavior');
  await screenshot(page, 'memory-edit');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(f.writes.find((w) => w.method === 'PATCH')?.body).toEqual({
    title: '负责 Q4 新品上线和定价',
    category: 'behavior',
  });
  await expect(inUse).toContainText('负责 Q4 新品上线和定价');
  await expect(inUse).toContainText('工作方式');

  await inUse.getByRole('button', { name: '负责 Q4 新品上线和定价的操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '置顶', exact: true }).click();
  await expect.poll(() => f.writes.filter((w) => w.method === 'PATCH').at(-1)?.body).toEqual({ pinned: true });
  await inUse.getByRole('button', { name: '负责 Q4 新品上线和定价的操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '归档', exact: true }).click();
  await expect.poll(() => f.writes.filter((w) => w.method === 'PATCH').at(-1)?.body).toEqual({ status: 'archived' });
  await expect(page.getByTestId('memory-archived')).toContainText('负责 Q4 新品上线和定价');
  await page
    .getByTestId('memory-archived')
    .getByRole('button', { name: '负责 Q4 新品上线和定价的操作', exact: true })
    .click();
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByText('负责 Q4 新品上线和定价')).toHaveCount(0);
  expect(f.writes.some((w) => w.method === 'DELETE')).toBe(true);
  // there is no create path anywhere on the page
  expect(f.writes.some((w) => w.method === 'POST')).toBe(false);

  f.state.memories = [];
  await page.reload();
  await expect(page.getByText('还没有记忆', { exact: true })).toBeVisible();
  await expect(page.getByText('这里不能新建', { exact: false })).toBeVisible();
  await screenshot(page, 'memory-empty');
});

test('Computer reads its state, price and limits in words, starts and stops, and explains a station without one', async ({
  page,
}) => {
  const f = await appStation(page);
  await ready(page, '/p/computer/computer');
  const status = page.getByTestId('computer-status');
  await expect(status).toContainText('未运行');
  const usage = page.getByTestId('computer-usage');
  await expect(usage).toContainText('42 分钟');
  await expect(usage).toContainText('约 US$0.09');
  await expect(usage).toContainText('每分钟 US$0.0021');
  await expect(usage).toContainText('每小时约 US$0.13');
  await expect(usage).toContainText('15 分钟没有使用后');
  const text = await page.getByTestId('computer-page').innerText();
  for (const raw of ['price_per_minute_usd', 'Price per minute usd', 'Configured', 'minutes_this_month', 'Computer —'])
    expect(text).not.toContain(raw);
  await screenshot(page, 'computer-stopped');

  await status.getByRole('button', { name: '启动电脑', exact: true }).click();
  await expect(status).toContainText('运行中');
  await expect(status).toContainText('启动');
  await screenshot(page, 'computer-running');
  await status.getByRole('button', { name: '停止电脑', exact: true }).click();
  const confirm = page.getByRole('dialog').filter({ hasText: '停止你的电脑？' });
  await expect(confirm).toContainText('里面的所有内容都会删除');
  await confirm.getByRole('button', { name: '停止电脑', exact: true }).click();
  await expect(status).toContainText('未运行');
  expect(f.writes.filter((w) => w.method === 'POST').map((w) => w.path)).toEqual([
    '/api/computer/start',
    '/api/computer/stop',
  ]);

  // a refused start says why in the app's words
  f.state.startRefusal = { status: 429, code: 'full' };
  await status.getByRole('button', { name: '启动电脑', exact: true }).click();
  await expect(page.getByRole('dialog').filter({ hasText: '电脑没能启动' })).toContainText('团队的云电脑都在使用中');

  // a station with the switch off explains who can turn it on, and offers no start
  f.state.computer.enabled = false;
  await page.reload();
  await expect(status).toContainText('已关闭');
  await expect(status).toContainText('管理员可以在「管理 › 云电脑管理」里开启');
  await expect(status.getByRole('button', { name: '启动电脑' })).toHaveCount(0);
  await screenshot(page, 'computer-off');
  f.state.computer.enabled = true;
  f.state.computer.configured = false;
  await page.reload();
  await expect(status).toContainText('尚未配置');
  await expect(status).toContainText('E2B API key');
});
