import { expect, test } from '@playwright/test';
import { open } from './fixtures';

test('the vault: a login goes in, shows only a masked user name, and can be edited and deleted', async ({ page }) => {
  await open(page, '/#/settings/vault');
  await expect(page.getByText('还没有保存的登录')).toBeVisible();
  await page.getByRole('button', { name: '添加登录' }).click();
  const drawer = page.getByRole('dialog', { name: '添加登录' });
  await drawer.getByLabel(/^名称/).fill('GitHub');
  await drawer.getByLabel(/^网站/).fill('https://github.com');
  await drawer.getByLabel('用户名').fill('linjie@example.com');
  await drawer.getByLabel('密码', { exact: true }).fill('s3cret-pass');
  await drawer.getByRole('button', { name: '保存' }).click();
  await expect(drawer).toBeHidden();

  const row = page.getByRole('main').getByRole('listitem').filter({ hasText: 'GitHub' });
  await expect(row).toContainText('github.com');
  await expect(row).toContainText('每次先问我');
  await expect(row).not.toContainText('linjie@example.com');
  await expect(page.getByText('s3cret-pass')).toHaveCount(0);

  // Saved values show as saved, never as text; the policy and the Agents change.
  await row.getByText('GitHub', { exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'GitHub' });
  await expect(edit.getByText('已保存')).toHaveCount(2);
  // Only the empty two-step field is an input; nothing holds the saved values.
  const inputs = await edit
    .locator('input')
    .evaluateAll((all) => all.map((input) => (input as HTMLInputElement).value));
  expect(inputs.some((value) => value.includes('s3cret') || value.includes('linjie@'))).toBe(false);
  await edit.getByRole('radio', { name: '直接使用' }).click();
  await edit.getByRole('button', { name: '保存' }).click();
  await expect(edit).toBeHidden();
  await expect(row).toContainText('直接使用');

  await page.getByRole('tab', { name: '使用记录' }).click();
  await expect(page.getByText('还没有使用记录')).toBeVisible();
  await page.getByRole('tab', { name: '登录' }).click();

  await row.getByRole('button', { name: 'GitHub的操作' }).click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '删除' }).click();
  await expect(page.getByText('还没有保存的登录')).toBeVisible();
});
