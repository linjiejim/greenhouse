import { expect, test } from '@playwright/test';
test('email settings surface', async ({ page }) => {
  await page.goto('/#/settings/email-accounts');
  await expect(page.getByTestId('email-accounts-add')).toBeVisible();
});
