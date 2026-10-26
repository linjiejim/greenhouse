import { expect, test } from '@playwright/test';
test('feishu settings surface', async ({ page }) => {
  await page.goto('/#/settings/provider-bindings');
  const token = await page.evaluate(() => localStorage.getItem('greenhouse_access_token'));
  const response = await page.request.get('/api/feishu/binding', { headers: { Authorization: `Bearer ${token}` } });
  expect(response.status()).toBe(200);
  const state = (await response.json()) as { available: boolean };
  if (!state.available) await expect(page.getByRole('button', { name: /Feishu/i })).toHaveCount(0);
});
