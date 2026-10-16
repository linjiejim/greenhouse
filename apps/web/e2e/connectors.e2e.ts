import { expect, test } from '@playwright/test';
import { apiAs, MCP_KEY, mcpUrl } from './api';
import { as, open } from './fixtures';

type Connector = { id: string; slug: string };

test('admin: install a connector from its address, choose what Agents may run, delete one from the catalog', async ({
  page,
}) => {
  await open(page, '/#/admin/connectors');
  await page.getByRole('button', { name: '添加连接器' }).click();
  const add = page.getByRole('dialog', { name: '添加连接器' });
  // The catalog speaks the member's language and says how far each entry was checked.
  await expect(add.getByRole('listitem').filter({ hasText: '高德地图' })).toContainText('每人自己的 Key · 已验证握手');
  await add.getByRole('tab', { name: '地址' }).click();
  await add.getByLabel('地址').fill(mcpUrl('open'));
  await add.getByRole('button', { name: '检测鉴权方式' }).click();
  await expect(add.getByText('不需要鉴权 · 3 个工具')).toBeVisible();
  await add.getByLabel(/^名称/).fill('Helpdesk');
  await expect(add.getByLabel('标识')).toHaveValue('helpdesk');
  await add.getByRole('button', { name: '安装', exact: true }).click();

  // Installed: its drawer opens with the tools it listed.
  const drawer = page.getByRole('dialog', { name: 'Helpdesk' });
  await expect(drawer.getByText('3 个工具 · 刚刚列出')).toBeVisible();
  const free = (name: string) => drawer.getByRole('switch', { name: `${name} 免确认` });
  // Declared read-only always runs freely; a tool that may delete data never can.
  await expect(free('lookup_order')).toHaveAttribute('aria-checked', 'true');
  await expect(free('lookup_order')).toBeDisabled();
  await expect(free('delete_ticket')).toBeDisabled();
  await free('create_ticket').click();
  await expect(free('create_ticket')).toHaveAttribute('aria-checked', 'true');
  await drawer.getByRole('switch', { name: 'Agent 可用 delete_ticket' }).click();
  await expect(drawer.getByRole('switch', { name: '全部工具' })).toHaveAttribute('aria-checked', 'false');
  await drawer.getByRole('button', { name: '测试连接' }).click();
  await expect(drawer.getByText(/连接正常 · 3 个工具/)).toBeVisible();
  await drawer.getByRole('textbox', { name: '说明', exact: true }).fill('Look up orders and open tickets.');
  await drawer.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByText('已保存')).toBeVisible();
  await drawer.getByRole('button', { name: '关闭详情' }).click();

  // Kept on the server.
  await page.reload();
  const row = page.getByRole('button', { name: /Helpdesk/ });
  await expect(row).toContainText('helpdesk · 无需鉴权 · 2 个工具 · 0 人已连接');
  await row.click();
  const again = page.getByRole('dialog', { name: 'Helpdesk' });
  await expect(again.getByRole('switch', { name: 'create_ticket 免确认' })).toHaveAttribute('aria-checked', 'true');
  await expect(again.getByRole('switch', { name: 'Agent 可用 delete_ticket' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect(again.getByRole('textbox', { name: '说明', exact: true })).toHaveValue(
    'Look up orders and open tickets.',
  );
  await again.getByRole('button', { name: '关闭详情' }).click();

  // From the catalog: a per-member connector lists its tools only with someone's own key.
  await page.getByRole('button', { name: '添加连接器' }).click();
  await page.getByRole('dialog', { name: '添加连接器' }).getByRole('button', { name: '安装高德地图' }).click();
  const amap = page.getByRole('dialog', { name: 'Amap Maps' });
  await expect(amap.getByText(/它按每个人的账号列工具/)).toBeVisible();
  await amap.getByRole('button', { name: '删除连接器' }).click();
  const confirm = page.getByRole('alertdialog', { name: '删除「Amap Maps」？' });
  await expect(confirm).toContainText('Agent 立即不能再用它的 0 个工具');
  await confirm.getByRole('button', { name: '删除连接器' }).click();
  await expect(page.getByRole('button', { name: /Amap Maps/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Helpdesk/ })).toBeVisible();
});

test('admin: a Registry search is slow, says so, and fills the address form or points at the catalog', async ({
  page,
}) => {
  // The real Registry is outside; answer its search here, slowly, as it does.
  await page.route('**/api/admin/connectors/registry**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({
      json: {
        items: [
          {
            name: 'io.example/desk',
            title: 'Example Desk',
            description: 'Tickets for the team',
            version: '1.0.0',
            website_url: null,
            remotes: [
              {
                transport: 'streamable_http',
                url: mcpUrl('key'),
                headers: [{ name: 'X-Api-Key', description: 'Your key', required: true, secret: true }],
              },
            ],
            catalog_id: null,
          },
          {
            name: 'com.amap/mcp',
            title: 'Amap Maps',
            description: 'Maps',
            version: '1.0.0',
            website_url: null,
            remotes: [{ transport: 'streamable_http', url: 'https://mcp.amap.com/mcp', headers: [] }],
            catalog_id: 'com.amap/mcp',
          },
        ],
      },
    });
  });
  await open(page, '/#/admin/connectors');
  await page.getByRole('button', { name: '添加连接器' }).click();
  const add = page.getByRole('dialog', { name: '添加连接器' });
  await add.getByRole('tab', { name: 'MCP Registry' }).click();
  await add.getByRole('textbox', { name: '搜索 MCP Registry' }).fill('desk');
  await add.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(add.getByRole('status')).toContainText('正在搜索 MCP Registry');
  await expect(add.getByText('Example Desk')).toBeVisible();

  // One the catalog has: install it from there.
  await add
    .getByRole('listitem')
    .filter({ hasText: 'Amap Maps' })
    .getByRole('button', { name: '在目录里安装' })
    .click();
  await expect(add.getByRole('tab', { name: '目录', selected: true })).toBeVisible();
  await expect(add.getByRole('button', { name: '安装高德地图' })).toBeVisible();

  // Another (the results are still there): its address fills the form, with each member's key in the header it names.
  await add.getByRole('tab', { name: 'MCP Registry' }).click();
  await add
    .getByRole('listitem')
    .filter({ hasText: 'Example Desk' })
    .getByRole('button', { name: '用这个地址' })
    .click();
  await expect(add.getByLabel('地址')).toHaveValue(mcpUrl('key'));
  await expect(add.getByLabel(/^名称/)).toHaveValue('Example Desk');
  await expect(add.getByRole('combobox', { name: '鉴权方式' })).toContainText('每人自己的 Key');
  await expect(add.getByLabel('请求头名称')).toHaveValue('X-Api-Key');
  await add.getByRole('button', { name: '检测鉴权方式' }).click();
  await expect(add.getByText('需要 Key：每人自己的，或者大家共用一个')).toBeVisible();
  await add.getByRole('button', { name: '安装', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Example Desk' })).toBeVisible();
});

test.describe('as Mei', () => {
  test.use({ storageState: as('mei') });

  test('a member connects their own key, tests it and disconnects', async ({ page, request }) => {
    await apiAs(request, 'lin', 'POST', '/api/admin/connectors', {
      slug: 'tickets',
      name: 'Ticket desk',
      url: mcpUrl('key'),
      auth_mode: 'per_member',
      auth_header: 'X-Api-Key',
      key_help: 'Your desk API key',
    });
    await open(page, '/#/settings/connections');
    const row = page.getByRole('listitem').filter({ hasText: 'Ticket desk' });
    await expect(row).toContainText('未连接');
    await expect(row).toContainText('用你自己的 Key · 连接后列出工具');
    await row.getByRole('button', { name: '连接', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: '连接 Ticket desk' });
    await expect(dialog.getByText('Your desk API key')).toBeVisible();
    await dialog.getByLabel('Key').fill('not-the-key');
    await dialog.getByRole('button', { name: '验证并连接' }).click();
    // The server tried it first and says so where it happened.
    await expect(dialog.getByRole('alert')).toContainText('Ticket desk 没有接受这个 Key');
    await dialog.getByLabel('Key').fill(MCP_KEY);
    await dialog.getByRole('button', { name: '验证并连接' }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toContainText('已连接');
    await expect(row).toContainText('3 个工具，1 个只读');

    await row.getByRole('button', { name: 'Ticket desk 的操作' }).click();
    await page.getByRole('menuitem', { name: '测试连接' }).click();
    await expect(page.getByText('Ticket desk 连接正常 · 3 个工具')).toBeVisible();

    await row.getByRole('button', { name: 'Ticket desk 的操作' }).click();
    await page.getByRole('menuitem', { name: '断开' }).click();
    const confirm = page.getByRole('alertdialog', { name: '断开 Ticket desk？' });
    await confirm.getByRole('button', { name: '断开' }).click();
    await expect(row).toContainText('未连接');
  });

  test('a member signs in to a connector and comes back connected; a sign-in someone else started is refused', async ({
    page,
    request,
  }) => {
    const connector = await apiAs<Connector>(request, 'lin', 'POST', '/api/admin/connectors', {
      slug: 'signin',
      name: 'Sign-in desk',
      url: mcpUrl('signin'),
      auth_mode: 'oauth',
    });
    await open(page, '/#/settings/connections');
    const row = page.getByRole('listitem').filter({ hasText: 'Sign-in desk' });
    await expect(row).toContainText('未连接');
    // To the provider (it approves at once), back through the callback, finished with Mei's session.
    await row.getByRole('button', { name: '登录' }).click();
    await expect(page.getByText('已连接 Sign-in desk')).toBeVisible();
    await expect(page).toHaveURL(/#\/settings\/connections$/);
    await expect(row).toContainText('已连接');
    await expect(row).toContainText('3 个工具');

    // Lin starts a sign-in; its state in Mei's browser does not connect Mei.
    const started = await apiAs<{ authorization_url: string }>(
      request,
      'lin',
      'POST',
      '/api/me/connections/oauth/start',
      {
        connector_id: connector.id,
      },
    );
    const state = new URL(started.authorization_url).searchParams.get('state')!;
    await page.goto(
      `/#/settings/connections?connector=${connector.id}&oauth_state=${encodeURIComponent(state)}&oauth_code=c1`,
    );
    await expect(page.getByText('这次登录是别人发起的，不能连到你的账号。请在这里重新登录。')).toBeVisible();
    await expect(page).toHaveURL(/#\/settings\/connections$/);

    // The provider said no.
    await page.goto(`/#/settings/connections?connector=${connector.id}&oauth_error=access_denied`);
    await expect(page.getByText('你在 Sign-in desk 那边取消了授权。')).toBeVisible();

    await row.getByRole('button', { name: 'Sign-in desk 的操作' }).click();
    await page.getByRole('menuitem', { name: '断开' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '断开' }).click();
    await expect(row).toContainText('未连接');
  });
});

test("the Agent's connectors: every one, or only the picked ones, saved when the list closes", async ({
  page,
  request,
}) => {
  for (const [slug, name] of [
    ['wiki', 'Team wiki'],
    ['crm', 'Sales CRM'],
  ])
    await apiAs(request, 'lin', 'POST', '/api/admin/connectors', { slug, name, url: mcpUrl('open') });
  const saved = async () =>
    (await apiAs<{ connectors: string[] | null }>(request, 'lin', 'GET', '/api/agents/main')).connectors;
  const option = (name: RegExp) => page.getByRole('option', { name });
  await open(page, '/#/agents/main?tab=abilities');
  const every = page.getByRole('switch', { name: '全部连接器' });
  await expect(every).toHaveAttribute('aria-checked', 'true');
  // Off: the connectors it can use now, each one picked.
  await every.click();
  const picker = page.getByRole('combobox', { name: '选择连接器' });
  await picker.click();
  await expect(option(/Team wiki/)).toHaveAttribute('aria-selected', 'true');
  await option(/Sales CRM/).click();
  await expect(option(/Sales CRM/)).toHaveAttribute('aria-selected', 'false');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await saved())?.join(',')).not.toContain('crm');
  expect(await saved()).toContain('wiki');

  await page.reload();
  await expect(page.getByRole('switch', { name: '全部连接器' })).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('combobox', { name: '选择连接器' }).click();
  await expect(option(/Team wiki/)).toHaveAttribute('aria-selected', 'true');
  await expect(option(/Sales CRM/)).toHaveAttribute('aria-selected', 'false');
  await page.keyboard.press('Escape');

  await page.getByRole('switch', { name: '全部连接器' }).click();
  await expect(page.getByRole('combobox', { name: '选择连接器' })).toHaveCount(0);
  expect(await saved()).toBeNull();
});
