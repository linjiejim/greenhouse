import { test, expect } from '@playwright/test';
test('opens the memory plugin surface', async ({ page }) => {
  await page.goto('/#/settings/memory');
  await expect(page.locator('[data-module-page="settings.memory"]')).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});
