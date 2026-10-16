import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Agent } from '@greenhouse/contract';
import { apiAs } from './api';
import { composer, open, sendForRequest } from './fixtures';

test('completed turns keep a failed attempt neutral and retain its reason', async ({ page }) => {
  await open(page, '/#/c/new');
  await composer(page).fill('u4a partial');
  await composer(page).press('Enter');
  await expect(page.getByText('Found it:', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeHidden();
  const process = page.locator('.gh-chat-card').filter({ hasText: '已完成，1 步未完成' });
  await expect(process).toBeVisible();
  await expect(process.locator('.gh-badge-danger')).toHaveCount(0);
  await process.locator('button').first().click();
  await expect(process.locator('.app-step-summary').filter({ hasText: '此网址指向受限网络' })).toBeVisible();
  await expect(process.locator('.app-step.is-failed')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('已完成，1 步未完成')).toBeVisible();
});

test('draft dismissal preserves input and narrow settings keep their actions visible', async ({ page, request }) => {
  test.setTimeout(60000);
  const agent = await apiAs<Agent>(request, 'lin', 'POST', '/api/agents', { name: 'U4a 日程检查' });
  await open(page, `/#/agents/${agent.id}?tab=schedules`);
  await page.getByRole('button', { name: '新建定时', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新建定时', exact: true });
  await form.getByRole('textbox', { name: /^名字/ }).fill('尚未保存的周报');
  await form.getByRole('button', { name: '关闭', exact: true }).click();
  const discard = page.getByRole('alertdialog');
  await expect(discard).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mkdir('../../artifacts/u4a/browser', { recursive: true });
  for (const theme of ['light', 'dark'] as const)
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
      await expect(discard).toBeInViewport();
      await page.screenshot({
        path: `../../artifacts/u4a/browser/discard-${theme}-${width}.png`,
        animations: 'disabled',
      });
    }
  await page.setViewportSize({ width: 1440, height: 900 });
  await discard.getByRole('button', { name: '取消', exact: true }).click();
  await expect(form.getByRole('textbox', { name: /^名字/ })).toHaveValue('尚未保存的周报');
  await form.getByRole('button', { name: '取消', exact: true }).click();
  await discard.getByRole('button', { name: '放弃更改', exact: true }).click();
  await expect(form).toBeHidden();
  await page.setViewportSize({ width: 390, height: 900 });
  await open(page, `/#/agents/${agent.id}?tab=activity`);
  await expect(page.getByRole('tab', { name: '用量与活动', exact: true })).toBeInViewport();
  await open(page, '/#/settings/vault');
  await mkdir('../../artifacts/u4a/browser', { recursive: true });
  for (const theme of ['light', 'dark'] as const)
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
      const add = page.getByRole('button', { name: '添加登录', exact: true });
      await expect(add).toBeInViewport();
      await page.screenshot({
        path: `../../artifacts/u4a/browser/vault-${theme}-${width}.png`,
        animations: 'disabled',
      });
    }
});

test('answered forms condense to one row and retain the answer in their history', async ({ page }) => {
  await open(page, '/#/c/new');
  await composer(page).fill('ask me');
  await composer(page).press('Enter');
  const card = page.locator('.gh-chat-card', { hasText: 'Which city?' });
  await card.getByRole('button', { name: '提交回答', exact: true }).click();
  const form = page.getByRole('dialog');
  await form.getByRole('textbox', { name: /City/ }).fill('Kyoto');
  await form.getByRole('button', { name: '提交回答', exact: true }).click();
  await expect(card.getByText('已完成', { exact: true })).toBeVisible();
  await expect(card.locator('.gh-chat-card-body')).toHaveCount(0);
  await card.locator('.gh-chat-card-header').click();
  await expect(card.getByText('Kyoto', { exact: true })).toBeVisible();
});

test('irreversible memory approval names the object and uses the danger action', async ({ page }) => {
  await open(page, '/#/c/new');
  await sendForRequest(page, undefined, 'u4a forget');
  const card = page.locator('.gh-chat-card').filter({ hasText: '彻底删除记忆「周报每周五发」' });
  await expect(card.getByRole('button', { name: '彻底删除记忆「周报每周五发」', exact: true })).toHaveClass(
    /gh-button-danger/,
  );
});
