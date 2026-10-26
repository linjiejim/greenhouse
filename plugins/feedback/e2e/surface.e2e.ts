import { test, expect } from '@playwright/test';
test('opens the feedback plugin surface', async ({ page }) => {
  await page.goto('/#/administration/issues');
  await expect(page.locator('[data-module-page="admin.issues"]')).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});
