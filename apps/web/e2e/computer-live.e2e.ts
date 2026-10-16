/** Run against stack.sh with the real image on the task's dedicated 4825–4827 ports. */
import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { AdminComputers } from '@greenhouse/contract';
import { apiAs } from './api';
import { as, open } from './fixtures';

test.skip(process.env.T12_LIVE_COMPUTER !== '1', 'Needs the real Docker stack.');
test('real computer: fullscreen in page/drawer, keyboard capture, backup UI and queued starts', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(120_000);
  const agent = await apiAs<{ id: string }>(request, 'lin', 'GET', '/api/agents/main');
  writeFileSync('../../node_modules/.cache/t12-computers.json', JSON.stringify([`gh-cmp-${agent.id.toLowerCase()}`]));
  await apiAs(request, 'lin', 'POST', '/api/agents/main/computer/start');
  await open(page, '/#/agents/main?tab=computer');
  await expect(async () => {
    const reconnect = page.getByRole('button', { name: '重新连接', exact: true });
    if (await reconnect.isVisible()) await reconnect.click();
    await expect(page.getByText('正在观看')).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 30_000, intervals: [1500] });
  await page.getByRole('button', { name: '全屏', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出全屏' })).toBeVisible();
  expect(await page.evaluate(() => document.fullscreenElement?.className)).toBe('app-screen');
  await page.getByRole('button', { name: '退出全屏' }).click();
  await page.getByRole('button', { name: '接管', exact: true }).click();
  await expect(page.getByText('你在操作这台电脑')).toBeVisible();
  const canvas = page.locator('.app-screen-canvas canvas');
  await expect(canvas).toBeVisible();
  await canvas.click();
  await canvas.press('Control+k');
  await expect(page.getByRole('dialog')).toBeHidden();
  await canvas.press('Control+j');
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('button', { name: '回到观看', exact: true }).click();
  await expect(page.getByText('正在观看')).toBeVisible();
  const dir = '../../node_modules/.cache/t12-screenshots';
  for (const [theme, width] of [
    ['light', 1440],
    ['dark', 1440],
    ['dark', 390],
  ] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${dir}/computer-${theme}-${width}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await page.getByRole('main').getByRole('button', { name: '电脑', exact: true }).click();
  const drawer = page.getByRole('dialog');
  await drawer.getByRole('button', { name: '全屏', exact: true }).click();
  await expect(drawer.getByRole('button', { name: '退出全屏' })).toBeVisible();
  await drawer.getByRole('button', { name: '退出全屏' }).click();
  const list = await apiAs<AdminComputers>(request, 'lin', 'GET', '/api/admin/computers');
  const computer = list.items[0]!;
  await apiAs(request, 'lin', 'POST', `/api/admin/computers/${computer.id}/backups`);
  await apiAs(request, 'lin', 'PUT', '/api/admin/computers/capacity', { idle_minutes: 30, max_running: 1 });
  const queued = await apiAs(request, 'mei', 'POST', '/api/agents/main/computer/start');
  expect(queued).toMatchObject({ state: 'queued', queue_position: 1 });
  const context = await browser.newContext({ storageState: as('mei') });
  try {
    const other = await context.newPage();
    await open(other, '/#/agents/main?tab=computer');
    await expect(other.getByText('排队中，第 1 位')).toBeVisible();
    await other.screenshot({ path: `${dir}/computer-queued.png`, fullPage: true });
  } finally {
    await context.close();
  }
  await apiAs(request, 'mei', 'POST', '/api/agents/main/computer/stop');
  await apiAs(request, 'lin', 'PUT', '/api/admin/computers/capacity', { idle_minutes: 30, max_running: 0 });
  await open(page, '/#/admin/services');
  await page.getByRole('button', { name: /电脑（沙箱）/ }).click();
  await expect(page.getByText('电脑容量', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '恢复备份', exact: true }).first()).toBeVisible();
  for (const [theme, width] of [
    ['light', 1440],
    ['dark', 1440],
    ['dark', 390],
  ] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('button', { name: '恢复备份', exact: true }).first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${dir}/computer-admin-${theme}-${width}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
