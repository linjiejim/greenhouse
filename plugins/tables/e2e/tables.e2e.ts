import { test, expect } from '@playwright/test';
test('tables: existing URLs render a created Base and the data catalog', async ({ page, request }) => {
  await page.goto('/#/tables');
  const token = await page.evaluate(() => localStorage.getItem('greenhouse_access_token'));
  const headers = { Authorization: `Bearer ${token}` };
  const name = `e2e-tables-${Date.now().toString(36)}`;
  const response = await request.post('/api/tables/bases', { headers, data: { name } });
  expect(response.ok()).toBeTruthy();
  const { base } = (await response.json()) as { base: { id: string } };
  try {
    await page.goto(`/#/tables/${base.id}`);
    await expect(page.locator('main').getByText(name, { exact: true }).first()).toBeVisible();
    await page.goto('/#/tables/catalog');
    await expect(page.locator('main').getByText(name, { exact: true }).first()).toBeVisible();
  } finally {
    expect((await request.post(`/api/tables/bases/${base.id}/archive`, { headers })).ok()).toBeTruthy();
  }
});
