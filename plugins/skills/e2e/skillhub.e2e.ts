import { test, expect } from '@playwright/test';
test('SkillHub keeps catalogue and core saved-prompt tabs', async ({ page }) => {
  await page.goto('/#/skillhub');
  await expect(page.getByRole('tab', { name: 'Skills', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'My prompts', exact: true }).click();
  await expect(page).toHaveURL(/tab=prompts/);
  await expect(page.getByRole('tab', { name: 'My prompts', exact: true })).toHaveAttribute('aria-selected', 'true');
});
