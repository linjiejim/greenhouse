import { expect, test } from '@playwright/test';
import { open } from './fixtures';

test('a schedule run now shows up in runs, opens with its result, and its list filters by Agent', async ({ page }) => {
  await open(page, '/#/agents/main?tab=schedules');
  await page.getByRole('button', { name: '新建定时' }).click();
  const dialog = page.getByRole('dialog', { name: '新建定时' });
  await dialog.getByLabel('名字').fill('Weekly digest');
  await dialog.getByLabel('简报').fill('Write the weekly digest.');
  await dialog.getByRole('button', { name: '创建定时' }).click();
  const row = page.getByRole('listitem').filter({ hasText: 'Weekly digest' });
  await row.getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: '立即运行' }).click();
  await expect(page.getByText('已开始「Weekly digest」')).toBeVisible();

  await page.goto('/#/runs?view=done');
  const run = page.getByRole('link', { name: /Weekly digest/ });
  await expect(run).toBeVisible({ timeout: 20_000 });
  await expect(run).toContainText('已完成');
  await run.click();
  const drawer = page.getByRole('dialog', { name: /Weekly digest/ });
  await expect(drawer.getByText('已完成')).toBeVisible();
  await expect(drawer.getByRole('heading', { name: '结果' })).toBeVisible();
  await drawer.getByRole('button', { name: '关闭' }).click();
  await expect(page).toHaveURL(/#\/runs\?view=done$/);

  await page.getByRole('main').getByRole('combobox', { name: '按 Agent 筛选' }).click();
  await page.getByRole('option', { name: 'Greeny' }).click();
  await expect(page.getByRole('link', { name: /Weekly digest/ })).toBeVisible();

  await page.goto('/#/runs?view=scheduled');
  await expect(page.getByRole('listitem').filter({ hasText: 'Weekly digest' })).toContainText('每天 09:00');
});
