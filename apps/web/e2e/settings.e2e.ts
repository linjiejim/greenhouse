import { expect, test } from '@playwright/test';
import { as, composer, open, signedOut } from './fixtures';
import { PEOPLE } from './env';

test.describe('as Kai', () => {
  test.use({ storageState: as('kai') });

  test('account: name, language, theme and password', async ({ page }) => {
    await open(page, '/#/settings/account');
    await page.getByLabel('名字').fill('Kai Chen');
    await page.getByLabel('关于我').fill('I work on mobile.');
    await page.getByRole('form', { name: '个人资料' }).getByRole('button', { name: '保存' }).click();
    await expect(page.getByText('已保存')).toBeVisible();

    await page.getByRole('radio', { name: '深色' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('radio', { name: 'English' }).click();
    await expect(page.getByRole('heading', { name: 'Account', level: 1 })).toBeVisible();
    await page.getByRole('radio', { name: '中文' }).click();
    await expect(page.getByRole('heading', { name: '账号', level: 1 })).toBeVisible();
    await page.getByRole('radio', { name: '跟随系统' }).click();

    await page.getByLabel('当前密码').fill('wrong one');
    await page.getByLabel('新密码').fill('a brand new secret');
    await page.getByRole('button', { name: '修改密码' }).click();
    await expect(page.getByText('当前密码不对')).toBeVisible();
    await page.getByLabel('当前密码').fill(PEOPLE.kai.password);
    await page.getByLabel('新密码').fill('a brand new secret');
    await page.getByRole('button', { name: '修改密码' }).click();
    await expect(page.getByText('密码已修改')).toBeVisible();
  });
});

test('admin: allow personal keys; a member adds and deletes one', async ({ page, browser }) => {
  await open(page, '/#/admin/services');
  await page.getByRole('button', { name: /大模型/ }).click();
  const drawer = page.getByRole('dialog', { name: '大模型' });
  await expect(drawer.getByText('环境变量')).toBeVisible();
  await drawer.getByRole('switch', { name: '允许成员用自己的 Key' }).click();
  await expect(drawer.getByRole('switch', { name: '允许成员用自己的 Key' })).toHaveAttribute('aria-checked', 'true');
  await drawer.getByRole('button', { name: '关闭' }).click();

  const mei = await browser.newContext({ storageState: as('mei'), locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const other = await mei.newPage();
  await other.goto('/#/settings/services');
  await expect(other.getByRole('heading', { name: '大模型' })).toBeVisible();
  await other.getByRole('button', { name: '添加我的 Key' }).click();
  const form = other.getByRole('dialog', { name: '添加大模型' });
  await form.getByLabel('名称').fill('My DeepSeek');
  await form.getByLabel('apiKey').fill('sk-test-not-real');
  await form.getByRole('button', { name: '添加', exact: true }).click();
  const row = other.getByRole('listitem').filter({ hasText: 'My DeepSeek' });
  await expect(row).toContainText('未测试');
  await row.getByRole('button', { name: 'My DeepSeek的操作' }).click();
  await other.getByRole('menuitem', { name: '删除' }).click();
  await expect(row).toHaveCount(0);
  await mei.close();

  // Put the policy back for the other tests.
  await page.getByRole('button', { name: /大模型/ }).click();
  await page.getByRole('dialog', { name: '大模型' }).getByRole('switch', { name: '允许成员用自己的 Key' }).click();
});

test('admin: invite someone, and the link signs them in after they set a password', async ({ page, browser }) => {
  await open(page, '/#/admin/members');
  await page.getByRole('button', { name: '邀请成员' }).click();
  const dialog = page.getByRole('dialog', { name: '邀请成员' });
  await dialog.getByLabel('邮箱').fill('rui@example.com');
  await dialog.getByLabel('名字').fill('Rui');
  await dialog.getByRole('button', { name: '生成邀请链接' }).click();
  const link = await page.getByRole('textbox', { name: '链接' }).inputValue();
  expect(link).toContain('#/activate?token=');
  await page.getByRole('button', { name: '完成' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Rui' })).toContainText('待激活');

  const fresh = await browser.newContext({ storageState: signedOut, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const rui = await fresh.newPage();
  await rui.goto(`/${link.slice(link.indexOf('#'))}`);
  await expect(rui.getByRole('heading', { name: '设置密码' })).toBeVisible();
  await expect(rui.getByText('rui@example.com')).toBeVisible();
  await rui.getByLabel('新密码').fill('rui secret password');
  await rui.getByRole('button', { name: '设置密码并进入' }).click();
  await expect(composer(rui)).toBeVisible();
  await fresh.close();

  await page.reload();
  await expect(page.getByRole('listitem').filter({ hasText: 'Rui' })).toContainText('已激活');
});

test('admin: groups and branding', async ({ page, browser }) => {
  await open(page, '/#/admin/members');
  await page.getByRole('tab', { name: '分组' }).click();
  await page.getByRole('button', { name: '新建分组' }).click();
  const drawer = page.getByRole('dialog', { name: '新建分组' });
  await drawer.getByLabel('分组名').fill('Design');
  await drawer.getByRole('combobox', { name: '成员' }).click();
  await page.getByRole('option', { name: /Mei/ }).click();
  await drawer.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Design' })).toContainText('1 人');

  await page.goto('/#/admin/branding');
  await page.getByLabel('工作区名称').fill('Acme Greenhouse');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('已保存')).toBeVisible();
  const fresh = await browser.newContext({ storageState: signedOut, locale: 'zh-CN' });
  const visitor = await fresh.newPage();
  await visitor.goto('/');
  await expect(visitor.getByRole('heading', { name: 'Acme Greenhouse' })).toBeVisible();
  await fresh.close();
  await page.getByLabel('工作区名称').fill('Greenhouse');
  await page.getByRole('button', { name: '保存' }).click();
});

test('admin: computer capacity, and every computer with its state', async ({ page }) => {
  await open(page, '/#/admin/services');
  await page.getByRole('button', { name: /^电脑/ }).first().click();
  const drawer = page.getByRole('dialog', { name: '电脑' });
  await expect(drawer.getByRole('heading', { name: '电脑容量' })).toBeVisible();
  await drawer.getByLabel('最多同时开机').fill('3');
  await drawer.getByLabel('空闲多久后关机（分钟）').fill('20');
  await drawer.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('已保存')).toBeVisible();
  await expect(drawer.getByRole('heading', { name: /电脑 · \d+ 台在运行，共 \d+ 台/ })).toBeVisible();
  // Personal keys are not a thing for computers.
  await expect(drawer.getByRole('switch', { name: '允许成员用自己的 Key' })).toHaveCount(0);
});

test('admin: email set up as a channel; a member picks what reaches them by email', async ({ page }) => {
  await open(page, '/#/admin/services');
  await page.getByRole('button', { name: /^邮件（SMTP）/ }).click();
  const drawer = page.getByRole('dialog', { name: '邮件（SMTP）' });
  await drawer.getByLabel('SMTP 主机').fill('127.0.0.1');
  await drawer.getByLabel('端口').fill('2525');
  await drawer.getByRole('radio', { name: '不加密' }).click();
  await drawer.getByLabel('发件地址').fill('greenhouse@example.com');
  await drawer.getByRole('button', { name: '保存' }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('button', { name: /^邮件（SMTP）/ })).toContainText('可用');

  await page.goto('/#/settings/notifications');
  const cell = page.getByRole('checkbox', { name: '需要你：邮件' });
  await expect(cell).not.toBeChecked();
  await cell.click();
  await expect(cell).toBeChecked();
  await expect(page.getByRole('switch', { name: '显示内容摘要' })).toHaveAttribute('aria-checked', 'false');
  await page.reload();
  await expect(page.getByRole('checkbox', { name: '需要你：邮件' })).toBeChecked();

  // Off again, so later tests send no mail.
  await page.goto('/#/admin/services');
  await page.getByRole('button', { name: /^邮件（SMTP）/ }).click();
  await drawer.getByRole('switch', { name: '启用' }).click();
  await drawer.getByRole('button', { name: '保存' }).click();
  await expect(drawer).toBeHidden();
});
