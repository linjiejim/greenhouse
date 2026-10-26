import { test, expect } from '@playwright/test';
test('opens the computer plugin surface', async ({ page }) => {
  await page.goto('/#/settings/computer');
  await expect(page.locator('[data-module-page="settings.computer"]')).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});
