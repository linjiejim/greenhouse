import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';

test('design examples fit narrow columns and diagram exports retain the brand radius', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('greenhouse-theme', 'system'));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 953, height: 888 });
  await page.goto('/#/design');
  const module = page.locator('#module-page');
  const badge = module.getByText('Consistent', { exact: true });
  await expect(badge).toBeVisible();
  expect((await badge.boundingBox())!.height).toBeLessThan(32);
  const content = module.getByText('Module content', { exact: true });
  expect(
    await content.evaluate((element) => {
      const card = element.closest('.bg-surface-card')!;
      return element.getBoundingClientRect().left - card.getBoundingClientRect().left;
    }),
  ).toBeGreaterThanOrEqual(16);

  for (const width of [953, 390]) {
    await page.setViewportSize({ width, height: 888 });
    const table = page.locator('#skeletons table');
    expect(
      await table.evaluate((element) => {
        const bounds = element.parentElement!.getBoundingClientRect();
        return (
          [...element.querySelectorAll('tbody .animate-skeleton')].every((bar) => {
            const rect = bar.getBoundingClientRect();
            return rect.width > 0 && rect.left >= bounds.left && rect.right <= bounds.right;
          }) && element.getBoundingClientRect().right <= bounds.right
        );
      }),
    ).toBe(true);
  }

  const diagrams = page.locator('#mermaid-block .mermaid-diagram');
  await expect(diagrams).toHaveCount(2);
  const node = diagrams.first().locator('.node > rect').first();
  const actor = diagrams.nth(1).locator('rect.actor').first();
  await expect(node).toHaveCSS('rx', '8px');
  await expect(actor).toHaveCSS('rx', '8px');
  // Live workspace radius edits must be carried into both the preview and export.
  await page.evaluate(() => document.documentElement.style.setProperty('--radius-md', '0.75rem'));
  await expect(actor).toHaveCSS('rx', '12px');
  await expect(node).toHaveCSS('rx', '12px');
  const lightFill = await actor.evaluate((element) => getComputedStyle(element).fill);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(actor).not.toHaveCSS('fill', lightFill);
  await expect(actor).toHaveCSS('rx', '12px');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#mermaid-block').getByRole('button', { name: 'Download SVG', exact: true }).nth(1).click(),
  ]);
  const exported = await fs.readFile((await download.path())!, 'utf8');
  expect(exported).toMatch(/rx:\s*12px/);
  expect(exported).toContain('Nunito');
});
