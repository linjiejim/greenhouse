import { expect, test } from '@playwright/test';
import { composer, open } from './fixtures';
import { mkdir } from 'node:fs/promises';

test('a reaction that lands while a new chat is loading its messages still shows', async ({ page }) => {
  const reacted = new Promise<void>((resolve) =>
    page.on('websocket', (socket) =>
      socket.on('framereceived', ({ payload }) => {
        if (String(payload).includes('"message.updated"') && String(payload).includes('👍')) resolve();
      }),
    ),
  );
  // The first page is the server's snapshot from before the reaction, delivered after its event.
  await page.route(/\/api\/conversations\/[^/]+\/messages\?limit=50$/, async (route) => {
    const response = await route.fetch();
    await reacted;
    await route.fulfill({ response });
  });
  await open(page, '/#/c/new');
  await composer(page).fill('u2 react');
  await composer(page).press('Enter');
  await expect(page.getByRole('img', { name: 'Agent 回应：👍' })).toBeVisible();
});

test('reactions, downloadable files and plans survive reload in light, dark and narrow layouts', async ({ page }) => {
  await open(page, '/#/c/new');
  await composer(page).fill('u2 react');
  await composer(page).press('Enter');
  await expect(page.getByRole('img', { name: 'Agent 回应：👍' })).toBeVisible();
  await mkdir('../../artifacts/u2/screenshots', { recursive: true });
  for (const [view, theme, width, height] of [
    ['light', 'light', 1440, 900],
    ['dark', 'dark', 1440, 900],
    ['narrow', 'light', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page
      .locator('.app-message-reactions')
      .screenshot({ path: `../../artifacts/u2/screenshots/reaction-${view}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await composer(page).fill('u2 file');
  await composer(page).press('Enter');
  await expect(page.getByRole('link', { name: '下载「export.csv」' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载「export.csv」' }).click();
  expect((await download).suggestedFilename()).toBe('export.csv');
  await composer(page).fill('u2 plan');
  await composer(page).press('Enter');
  const plan = page.locator('.gh-chat-card').filter({ has: page.getByRole('button', { name: '计划', exact: true }) });
  await expect(plan).toBeVisible();
  await plan.getByRole('button', { name: '计划', exact: true }).click();
  await expect(plan.getByText('Compare options')).toBeVisible();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeHidden();
  await mkdir('../../artifacts/u2/screenshots', { recursive: true });
  for (const [name, theme, width, height] of [
    ['light', 'light', 1440, 900],
    ['dark', 'dark', 1440, 900],
    ['narrow', 'light', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.screenshot({
      path: `../../artifacts/u2/screenshots/tools-${name}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.reload();
  await expect(page.getByRole('img', { name: 'Agent 回应：👍' })).toBeVisible();
  await expect(page.getByRole('link', { name: '下载「export.csv」' })).toBeVisible();
});
