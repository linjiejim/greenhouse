import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Base } from '@greenhouse/contract';
import { apiAs } from './api';

// Hold a real module request instead of making the whole browser/network arbitrarily slow.
test('a delayed table module keeps the shell, header and accessible skeleton in place', async ({ page, request }) => {
  const base = await apiAs<Base>(request, 'lin', 'POST', '/api/tables/bases', { name: 'Loading delivery' });
  const pictures = new URL('../../../artifacts/t10-integration/loading/', import.meta.url).pathname;
  mkdirSync(pictures, { recursive: true });
  for (const [theme, width] of [
    ['light', 1440],
    ['dark', 1440],
    ['light', 390],
    ['dark', 390],
  ] as const) {
    await page.goto('about:blank');
    await page.setViewportSize({ width, height: 900 });
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    await page.route('**/src/pages/tables/BasePage.tsx*', async (route) => {
      started();
      await held;
      await route.continue();
    });
    try {
      await page.goto(`/#/tables/${base.id}/${base.tables[0]!.id}`, { waitUntil: 'domcontentloaded' });
      await requested;
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      const main = page.getByRole('main');
      await expect(main.getByRole('status', { name: '加载中', exact: true })).toBeVisible();
      const before = await main.locator('.app-page-header').boundingBox();
      await page.screenshot({ path: `${pictures}skeleton-${theme}-${width}.png`, animations: 'disabled' });
      release();
      await expect(main.getByRole('button', { name: '添加记录', exact: true })).toBeVisible();
      await expect(main.getByRole('status', { name: '加载中', exact: true })).toHaveCount(0);
      const after = await main.locator('.app-page-header').boundingBox();
      expect(after?.y).toBe(before?.y);
      expect(after?.height).toBe(before?.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${pictures}loaded-${theme}-${width}.png`, animations: 'disabled' });
    } finally {
      release();
      await page.unroute('**/src/pages/tables/BasePage.tsx*');
    }
  }
});
