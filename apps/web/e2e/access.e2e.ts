import { OAUTH_SCOPES } from '@greenhouse/contract';
import { expect, test, type Browser } from '@playwright/test';
import {
  APP_CALLBACK,
  apiAs,
  authorize,
  clientCredentials,
  exchangeCode,
  mcpInitialize,
  registerApp,
  WEB,
} from './api';
import { PEOPLE } from './env';
import { as, open, signedOut } from './fixtures';

/** A browser for one person whose outside app answers at APP_CALLBACK. */
async function personWithApp(browser: Browser, storageState: string | typeof signedOut) {
  const context = await browser.newContext({ storageState, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const page = await context.newPage();
  await page.route(`${APP_CALLBACK}**`, (route) => route.fulfill({ body: 'Back in the app' }));
  return { context, page };
}

test.describe('as Mei', () => {
  test.use({ storageState: as('mei') });

  test('a personal token shows once, works for MCP, and stops when revoked', async ({ page, request }) => {
    await open(page, '/#/settings/access');
    await page.getByRole('button', { name: '创建令牌' }).click();
    const dialog = page.getByRole('dialog', { name: '创建令牌' });
    await dialog.getByLabel(/^名称/).fill('Laptop CLI');
    await dialog.getByRole('checkbox', { name: /读取你的对话/ }).check();
    await dialog.getByRole('button', { name: '创建令牌' }).click();

    const shown = page.getByRole('dialog', { name: '复制令牌「Laptop CLI」' });
    const token = await shown.getByRole('textbox', { name: '令牌' }).inputValue();
    expect(token.length).toBeGreaterThan(20);
    await expect(shown).toContainText('只显示这一次');
    await shown.getByRole('button', { name: '完成' }).click();
    await expect(shown).toBeHidden();
    const row = page.getByRole('listitem').filter({ hasText: 'Laptop CLI' });
    await expect(row).toContainText('查看你的 Agent、向你的 Agent 提问、读取你的对话 · 还没用过');
    // The page never shows it again.
    await expect(page.getByText(token)).toHaveCount(0);

    // It is a bearer token for /api/mcp, and the list says it was used.
    expect((await mcpInitialize(request, token)).status()).toBe(200);
    await page.reload();
    await expect(row).toContainText('刚刚用过');

    await row.getByRole('button', { name: '撤销' }).click();
    await page
      .getByRole('alertdialog', { name: '撤销令牌「Laptop CLI」？' })
      .getByRole('button', { name: '撤销' })
      .click();
    await expect(row).toHaveCount(0);
    expect((await mcpInitialize(request, token)).status()).toBe(401);
  });
});

test('consent: Mei allows fewer scopes than asked, and the app gets just those; revoking ends them', async ({
  browser,
  request,
}) => {
  const clientId = await registerApp(request, 'Notes app');
  const { location, verifier } = await authorize(request, clientId, 'agents:read agents:ask conversations:read');
  expect(location).toContain('#/oauth/consent?request=');
  const { context, page } = await personWithApp(browser, as('mei'));
  await page.goto(location);
  await expect(page.getByRole('heading', { name: '「Notes app」想访问你的 Greenhouse' })).toBeVisible();
  await expect(page.getByText(`它会以 Mei（${PEOPLE.mei.email}）的身份工作`)).toBeVisible();
  // It named itself: say so.
  await expect(page.getByText(/这个应用是自己注册的/)).toBeVisible();
  await expect(page.getByText(`允许后回到 127.0.0.1:${new URL(WEB).port}。`)).toBeVisible();
  // Only what it asked for, all ticked; Mei unticks one.
  await expect(page.getByRole('checkbox')).toHaveCount(3);
  await page.getByRole('checkbox', { name: /读取你的对话/ }).uncheck();
  await page.getByRole('button', { name: '允许' }).click();

  await page.waitForURL(`${APP_CALLBACK}**`);
  const back = new URL(page.url());
  expect(back.searchParams.get('state')).toBe('e2e-state');
  const tokens = await exchangeCode(request, clientId, back.searchParams.get('code')!, verifier);
  expect(tokens.scope.split(' ').sort()).toEqual(['agents:ask', 'agents:read']);
  expect((await mcpInitialize(request, tokens.access_token)).status()).toBe(200);

  await page.goto(`${WEB}/#/settings/access`);
  const row = page.getByRole('listitem').filter({ hasText: 'Notes app' });
  await expect(row).toContainText('Notes app · 自行注册');
  await expect(row).toContainText('查看你的 Agent、向你的 Agent 提问');
  await row.getByRole('button', { name: '撤销' }).click();
  await page
    .getByRole('alertdialog', { name: '撤销「Notes app」的授权？' })
    .getByRole('button', { name: '撤销' })
    .click();
  await expect(row).toHaveCount(0);
  expect((await mcpInitialize(request, tokens.access_token)).status()).toBe(401);
  await context.close();
});

test('consent: signed out signs in first; denying tells the app; a used, taken or bad link says why', async ({
  browser,
  request,
}) => {
  const clientId = await registerApp(request, 'Stranger');
  const first = await authorize(request, clientId);
  const { context, page } = await personWithApp(browser, signedOut);
  await page.goto(first.location);
  await page.getByLabel(/邮箱|Email/).fill(PEOPLE.mei.email);
  await page.getByLabel(/密码|Password/).fill(PEOPLE.mei.password);
  await page.getByRole('button', { name: /登录|Sign in/ }).click();
  // The same request, now as Mei; it asked for nothing in particular, so everything is listed.
  await expect(page.getByRole('heading', { name: '「Stranger」想访问你的 Greenhouse' })).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(OAUTH_SCOPES.length);
  await page.getByRole('button', { name: '拒绝' }).click();
  await page.waitForURL(`${APP_CALLBACK}**`);
  expect(new URL(page.url()).searchParams.get('error')).toBe('access_denied');

  // Spent.
  await page.goto(first.location);
  await expect(page.getByText('这个授权链接已过期、已经用过，或者是别人的。回到那个应用重新连接。')).toBeVisible();

  // Someone else opened it first: it is theirs.
  const second = await authorize(request, clientId);
  const request2 = new URL(second.location.replace('#/', '')).searchParams.get('request')!;
  await apiAs(request, 'lin', 'GET', `/api/oauth/consent?request=${encodeURIComponent(request2)}`);
  await page.goto(second.location);
  await expect(page.getByText('这个授权链接已过期、已经用过，或者是别人的。回到那个应用重新连接。')).toBeVisible();

  // The app was turned off after it asked.
  const third = await authorize(request, clientId);
  await apiAs(request, 'lin', 'PATCH', `/api/admin/clients/${clientId}`, { status: 'disabled' });
  await page.goto(third.location);
  await expect(page.getByText('这个应用已被停用或删除，不能再连接。')).toBeVisible();

  // /oauth/authorize found the link itself bad.
  const bad = await authorize(request, 'cli_unknown');
  expect(bad.location).toContain('#/oauth/consent?error=invalid_client');
  await page.goto(bad.location);
  await expect(page.getByText('找不到这个应用，或者它已被停用。')).toBeVisible();
  await context.close();
});

test('admin: a machine client acts for Mei only once she approves; rotate, disable and delete it', async ({
  page,
  browser,
  request,
}) => {
  await open(page, '/#/admin/access');
  await page.getByRole('button', { name: '添加客户端' }).click();
  const dialog = page.getByRole('dialog', { name: '添加客户端' });
  await dialog.getByRole('radio', { name: '机器' }).click();
  await dialog.getByLabel(/^名称/).fill('Nightly sync');
  await dialog.getByRole('combobox', { name: '代表的成员' }).click();
  await page.getByRole('option', { name: /Mei/ }).click();
  await dialog.getByRole('button', { name: '添加客户端' }).click();

  const shown = page.getByRole('dialog', { name: '已添加「Nightly sync」' });
  const clientId = await shown.getByRole('textbox', { name: '客户端 ID' }).inputValue();
  const secret = await shown.getByRole('textbox', { name: '客户端密钥' }).inputValue();
  await shown.getByRole('button', { name: '完成' }).click();
  const row = page.getByRole('row').filter({ hasText: 'Nightly sync' });
  await expect(row).toContainText('Mei · 待批准');
  // Not before Mei says yes.
  expect((await clientCredentials(request, clientId, secret)).status()).toBe(400);

  const mei = await browser.newContext({ storageState: as('mei'), locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const other = await mei.newPage();
  await other.goto('/#/settings/access');
  const grant = other.getByRole('listitem').filter({ hasText: 'Nightly sync' });
  await expect(grant).toContainText('需要你');
  await expect(grant).toContainText('管理员让它以你的身份工作');
  await grant.getByRole('button', { name: '批准' }).click();
  await expect(other.getByText('已批准「Nightly sync」')).toBeVisible();
  await mei.close();
  expect((await clientCredentials(request, clientId, secret)).status()).toBe(200);
  await page.reload();
  await expect(row).not.toContainText('待批准');

  // A new secret: the old one stops at once.
  await row.getByRole('button', { name: 'Nightly sync的操作' }).click();
  await page.getByRole('menuitem', { name: '轮换密钥' }).click();
  await page
    .getByRole('alertdialog', { name: '轮换「Nightly sync」的密钥？' })
    .getByRole('button', { name: '轮换密钥' })
    .click();
  const rotated = page.getByRole('dialog', { name: '「Nightly sync」的新密钥' });
  const fresh = await rotated.getByRole('textbox', { name: '客户端密钥' }).inputValue();
  await rotated.getByRole('button', { name: '完成' }).click();
  expect((await clientCredentials(request, clientId, secret)).status()).toBe(401);
  expect((await clientCredentials(request, clientId, fresh)).status()).toBe(200);

  await row.getByRole('button', { name: 'Nightly sync的操作' }).click();
  await page.getByRole('menuitem', { name: '停用' }).click();
  await page.getByRole('alertdialog', { name: '停用「Nightly sync」？' }).getByRole('button', { name: '停用' }).click();
  await expect(row).toContainText('已停用');
  expect((await clientCredentials(request, clientId, fresh)).status()).toBe(401);

  await row.getByRole('button', { name: 'Nightly sync的操作' }).click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('alertdialog', { name: '删除「Nightly sync」？' }).getByRole('button', { name: '删除' }).click();
  await expect(row).toHaveCount(0);
});

test('admin: an interactive client gets its ID to hand over, and its consent page has no warning', async ({
  page,
  browser,
  request,
}) => {
  await open(page, '/#/admin/access');
  await page.getByRole('button', { name: '添加客户端' }).click();
  const dialog = page.getByRole('dialog', { name: '添加客户端' });
  await dialog.getByLabel(/^名称/).fill('Team notes');
  await dialog.getByLabel(/^回调地址/).fill(APP_CALLBACK);
  await dialog.getByRole('button', { name: '添加客户端' }).click();
  const shown = page.getByRole('dialog', { name: '已添加「Team notes」' });
  const clientId = await shown.getByRole('textbox', { name: '客户端 ID' }).inputValue();
  await expect(shown.getByRole('textbox', { name: '客户端密钥' })).toHaveCount(0);
  await shown.getByRole('button', { name: '完成' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Team notes' })).toContainText('管理员添加');

  const { location } = await authorize(request, clientId, 'runs:read');
  const { context, page: mei } = await personWithApp(browser, as('mei'));
  await mei.goto(location);
  await expect(mei.getByRole('heading', { name: '「Team notes」想访问你的 Greenhouse' })).toBeVisible();
  await expect(mei.getByText(/这个应用是自己注册的/)).toHaveCount(0);
  await expect(mei.getByRole('checkbox', { name: /查看你的运行/ })).toBeChecked();
  await context.close();
});
