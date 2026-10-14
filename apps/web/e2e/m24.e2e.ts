import { expect, test } from '@playwright/test';
import { apiAs } from './api';
import { as, composer, open } from './fixtures';

test('publication chooses knowledge folders and the public Agent cites only that grant', async ({
  page,
  request,
  browser,
}) => {
  const folder = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/knowledge/folders', {
    name: 'M24 granted sources',
    space: 'personal',
  });
  await apiAs(request, 'lin', 'POST', '/api/knowledge/docs', {
    title: 'M24 granted handbook',
    content: 'M24grant Friday',
    folder_id: folder.id,
  });
  await apiAs(request, 'lin', 'POST', '/api/knowledge/docs', {
    title: 'M24 private handbook',
    content: 'M24grant secret',
  });
  const agent = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/agents', {
    name: 'M24 reference',
    role: 'Read granted sources',
  });
  await open(page, `/#/agents/${agent.id}?tab=publish`);
  await page.getByRole('checkbox', { name: 'M24 granted sources', exact: true }).check();
  await page.getByRole('radio', { name: '整个工作区', exact: true }).click();
  await page.getByRole('button', { name: '发布', exact: true }).click();
  await expect(page.getByText('已发布', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'M24 granted sources', exact: true })).toBeChecked();
  await page.getByRole('button', { name: '清除全部知识授权' }).click();
  await expect(page.getByRole('checkbox', { name: 'M24 granted sources', exact: true })).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'M24 granted sources', exact: true }).check();
  const context = await browser.newContext({ storageState: as('mei') });
  const reader = await context.newPage();
  const thread = await apiAs<{ id: string }>(request, 'mei', 'POST', '/api/conversations', {
    kind: 'direct',
    agent_id: agent.id,
  });
  await open(reader, `/#/c/${thread.id}`);
  await composer(reader).fill('look up M24grant');
  await composer(reader).press('Enter');
  await expect(reader.getByText('Found it in', { exact: false }).first()).toBeVisible();
  await expect(reader.getByText('M24 private handbook', { exact: false })).toHaveCount(0);
  await expect(reader.getByRole('link', { name: 'M24 granted handbook' }).first()).toBeVisible();
  await context.close();
});

test('helper runs appear within the parent process card with completion summaries', async ({ page }) => {
  await open(page);
  await composer(page).fill('delegate helpers');
  await composer(page).press('Enter');
  await expect(page.getByText('Helper reports combined.', { exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByText('开始了 2 个子运行', { exact: true }).click();
  await expect(page.getByRole('link', { name: 'M24 source one', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'M24 source two', exact: true })).toBeVisible();
  await expect(page.getByText('A bounded helper summary.', { exact: true })).toHaveCount(2);
});
