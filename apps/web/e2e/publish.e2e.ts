import { expect, test } from '@playwright/test';
import { as, composer, open } from './fixtures';

test('publish an Agent to Mei: she talks to it, a pause stops her, usage counts her', async ({ page, browser }) => {
  await open(page, '/#/agents');
  await page.getByRole('button', { name: '新建 Agent' }).first().click();
  const drawer = page.getByRole('dialog', { name: '新建 Agent' });
  await drawer.getByRole('button', { name: /空白 Agent/ }).click();
  await drawer.getByLabel('名字').fill('Helper');
  await drawer.getByLabel('职责').fill('Answers questions');
  await drawer.getByRole('button', { name: '创建 Agent' }).click();
  await expect(page).toHaveURL(/#\/c\/cnv_/);

  await page.goto('/#/agents');
  await page.getByRole('link', { name: /Helper/ }).click();
  await page.getByRole('tab', { name: '发布' }).click();
  await page.getByRole('combobox', { name: '选择成员或分组' }).click();
  await page.getByRole('option', { name: /Mei/ }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '发布', exact: true }).click();
  await expect(page.getByText('已发布版本 1').first()).toBeVisible();

  const mei = await browser.newContext({ storageState: as('mei'), locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const other = await mei.newPage();
  await other.goto('/#/agents?scope=public');
  await other.getByRole('button', { name: /Helper/ }).click();
  await expect(other).toHaveURL(/#\/c\/cnv_/);
  await composer(other).fill('hi helper');
  await composer(other).press('Enter');
  await expect(other.getByText('Echo: hi helper')).toBeVisible();

  await page.goto('/#/admin/public-agents');
  const row = page.getByRole('listitem').filter({ hasText: 'Helper' });
  await expect(row).toContainText('Lin');
  await row.getByRole('button', { name: '暂停' }).click();
  await expect(row.getByText('已暂停')).toBeVisible();

  await composer(other).fill('are you there');
  await composer(other).press('Enter');
  await expect(other.getByText('管理员暂停了这个 Agent，暂时不能和它对话')).toBeVisible();
  await expect(composer(other)).toHaveValue('are you there');
  await row.getByRole('button', { name: '恢复' }).click();
  await mei.close();

  await page.goto('/#/agents');
  await page.getByRole('link', { name: /Helper/ }).click();
  await page.getByRole('tab', { name: '用量与活动' }).click();
  const people = page.locator('.app-stat').filter({ hasText: '用过的人' });
  await expect(people).toContainText('1');
});

test('admin usage shows tokens, and a workspace budget can be added', async ({ page }) => {
  await open(page, '/#/admin/usage');
  await expect(page.locator('.app-stat').first()).toContainText('tokens');
  await page.getByRole('button', { name: '添加预算' }).click();
  const dialog = page.getByRole('dialog', { name: '添加预算' });
  await dialog.getByLabel('每月上限').fill('5000000');
  await dialog.getByRole('button', { name: '保存' }).click();
  const budget = page.getByRole('listitem').filter({ hasText: '整个工作区' });
  await expect(budget).toBeVisible();
  await budget.getByRole('button', { name: /的操作/ }).click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '删除' }).click();
  await expect(budget).toHaveCount(0);
});
