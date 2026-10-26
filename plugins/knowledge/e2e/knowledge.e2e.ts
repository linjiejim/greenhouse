import { test, expect } from '@playwright/test';
test('opens the document library and creates a team document through the unchanged API', async ({ page }) => {
  await page.goto('/#/knowledge');
  const token = await page.evaluate(() => localStorage.getItem('greenhouse_access_token'));
  const headers = { Authorization: `Bearer ${token}` };
  const title = `e2e-knowledge-${Date.now()}`;
  const created = await page.request.post('/api/knowledge/docs', {
    headers,
    data: { title, content_markdown: 'Knowledge plugin browser fixture', visibility: 'team' },
  });
  expect(created.ok()).toBeTruthy();
  const body = await created.json();
  const doc = body.doc ?? body.document;
  try {
    await page.goto(`/#/knowledge/doc/${doc.id}-${doc.slug}`);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  } finally {
    await page.request.delete(`/api/knowledge/docs/${doc.id}`, { headers });
  }
});
