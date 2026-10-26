import { test, expect } from '@playwright/test';
test('exposes the monthly review page and preserves its admin endpoint', async ({ page }) => {
  await page.goto('/#/administration/retro');
  const token = await page.evaluate(() => localStorage.getItem('greenhouse_access_token'));
  const headers = { Authorization: `Bearer ${token}` };
  await expect(page.getByTestId('retro-generate')).toBeVisible();
  const bad = await page.request.post('/api/admin/retro', { headers, data: { month: 'invalid' } });
  expect(bad.status()).toBe(400);
});
