import { expect, test } from '@playwright/test';
import { apiAs } from './api';
import { composer, open } from './fixtures';

test('image generation and editing yield preview, download and knowledge cards', async ({ page, request }) => {
  await open(page, '/#/c/new');
  await composer(page).fill('make image of a sprout');
  await composer(page).press('Enter');
  const card = page.locator('.gh-chat-card').filter({ has: page.getByRole('button', { name: '保存到知识库' }) });
  await expect(card.locator('img')).toBeVisible();
  const download = page.waitForEvent('download');
  await card.getByRole('button', { name: '下载', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('image-1.png');
  const id = new URL(page.url()).hash.replace('#/c/', '');
  const messages = await apiAs<{ items: { attachments: string[] }[] }>(
    request,
    'lin',
    'GET',
    `/api/conversations/${id}/messages`,
  );
  const file = messages.items.flatMap((message) => message.attachments)[0]!;
  await composer(page).fill(`make image greener from ${file}`);
  await composer(page).press('Enter');
  await expect(card).toHaveCount(2);
  await card.last().getByRole('button', { name: '保存到知识库' }).click();
  await expect(page).toHaveURL(/#\/knowledge\?space=personal&file=fil_/);
});

test('approved video appears in Runs with progress and returns as a playable artifact', async ({ page }, testInfo) => {
  await open(page, '/#/c/new');
  await composer(page).fill('make video of a sprout moving');
  await composer(page).press('Enter');
  const approval = page.locator('.gh-chat-card').filter({ hasText: '提示词' });
  await expect(approval.getByText('需要你', { exact: true })).toBeVisible();
  await approval.getByRole('button', { name: '批准', exact: true }).click();
  const video = page.locator('video');
  await expect(video).toBeVisible({ timeout: 20000 });
  await video.evaluate((element: HTMLVideoElement) => element.play());
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
  await video.evaluate((element: HTMLVideoElement) => element.pause());
  const chat = page.url();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), theme);
    await page.waitForTimeout(400);
    await page.screenshot({ path: testInfo.outputPath(`video-${theme}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: testInfo.outputPath('video-390-dark.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/#/runs?view=done');
  await page.getByText('生成视频', { exact: true }).first().click();
  await expect(page.getByRole('dialog').getByText('视频进度：100%')).toBeVisible();
  await expect(page.getByRole('dialog').locator('video')).toBeVisible();
  await page.goto(chat);
  const card = page.locator('.gh-chat-card').filter({ has: page.locator('video') });
  const download = page.waitForEvent('download');
  await card.getByRole('button', { name: '下载', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('video.mp4');
  await card.getByRole('button', { name: '保存到知识库' }).click();
  await expect(page).toHaveURL(/#\/knowledge\?space=personal&file=fil_/);
  await expect(page.locator('video')).toBeVisible();
});

test('an asker’s interjection splits the reply at a boundary and is marked incorporated', async ({ page }) => {
  await open(page, '/#/c/new');
  await composer(page).fill('slow response for interjection');
  await composer(page).press('Enter');
  await expect(page.getByText('Thinking about it slowly.', { exact: false })).toBeVisible();
  await composer(page).fill('new detail for this reply');
  await composer(page).press('Enter');
  await expect(page.getByText('已带入当前回答', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/Echo: new detail for this reply/)).toBeVisible();
});

test('admin usage shows weekly count-only metrics and older weeks', async ({ page }) => {
  await open(page, '/#/admin/usage');
  const metrics = page.getByRole('region', { name: '每周使用指标' });
  await expect(metrics.getByText('每位活跃成员采纳的产出')).toBeVisible();
  await expect(metrics.getByText('第 3 档占比')).toBeVisible();
  await expect(metrics.getByText('事件叫醒次数')).toBeVisible();
  await metrics.getByRole('combobox', { name: /周（UTC）/ }).click();
  await page.getByRole('option').nth(1).click();
  await expect(metrics.getByText('暂无样本', { exact: false })).toBeVisible();
});
