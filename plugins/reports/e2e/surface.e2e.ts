import { test, expect } from '@playwright/test';
test('opens the reports plugin surface', async ({ page }) => {
  await page.goto('/#/skillhub?tab=reports');
  await expect(page.locator('[data-module-page="workspace.skillhub"]')).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});
