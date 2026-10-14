import { expect, test } from '@playwright/test';
import { PEOPLE } from './env';
import { as, open, signIn, signedOut } from './fixtures';

test.describe('signed out', () => {
  test.use({ storageState: signedOut });

  test('signing in: a wrong password says so, the right one opens the main thread', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Greenhouse' })).toBeVisible();
    await page.getByLabel('邮箱').fill(PEOPLE.lin.email);
    await page.getByLabel('密码').fill('not the password');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByRole('alert')).toHaveText('邮箱或密码不对');

    await page.getByLabel('密码').fill(PEOPLE.lin.password);
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page).toHaveURL(/#\/c\/main$|\/$/);
    await expect(page.getByRole('link', { name: 'Greeny' })).toBeVisible();
    await expect(page.getByText('你好，我是 Greeny', { exact: false })).toBeVisible();
  });

  test('the session survives a reload and ends with sign-out', async ({ page }) => {
    await signIn(page);
    await page.reload();
    await expect(page.getByRole('textbox', { name: '给 Greeny 发消息' })).toBeVisible();
    await page.getByRole('button', { name: '账户' }).click();
    await page.getByRole('menuitem', { name: '退出登录' }).click();
    await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
  });
});

test('⌘K finds commands, Agents and settings and goes there', async ({ page }) => {
  await open(page);
  await page.keyboard.press('ControlOrMeta+k');
  const search = page.getByRole('combobox', { name: '搜索对话、文档、表格、Agent 和设置' });
  await expect(search).toBeFocused();
  await expect(page.getByRole('option', { name: '新会话' })).toBeVisible();
  await search.fill('我的服务');
  await expect(page.getByRole('option', { name: '我的服务' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/settings\/services$/);
  await expect(page.getByRole('heading', { name: '我的服务', level: 1 })).toBeVisible();
});

test('the rail: notifications, runs and the account menu; admins see 管理', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '通知' }).click();
  await expect(page).toHaveURL(/#\/notifications$/);
  await expect(page.getByText('没有需要你处理的事')).toBeVisible();
  await page.getByRole('link', { name: '全部' }).click();
  await expect(page).toHaveURL(/#\/notifications\?view=all$/);

  await page.getByRole('button', { name: '运行' }).click();
  await expect(page).toHaveURL(/#\/runs$/);

  await page.getByRole('button', { name: '账户' }).click();
  await page.getByRole('menuitem', { name: '管理' }).click();
  await expect(page).toHaveURL(/#\/admin\/members$/);
});

test.describe('as a member', () => {
  test.use({ storageState: as('mei') });

  test('members do not see admin pages', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: '账户' }).click();
    await expect(page.getByRole('menuitem', { name: '管理' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.goto('/#/admin/members');
    await expect(page.getByRole('heading', { name: '没有这个页面', level: 1 })).toBeVisible();
  });
});

test('narrow screens: the directory is a drawer with the module bar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeHidden();
  await page.getByRole('button', { name: '菜单' }).click();
  const drawer = page.getByRole('complementary', { name: '目录' });
  await expect(drawer.getByRole('link', { name: 'Greeny' })).toBeVisible();
  await expect(drawer.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await drawer.getByRole('link', { name: 'Greeny' }).click();
  await expect(drawer).toBeHidden();
});
