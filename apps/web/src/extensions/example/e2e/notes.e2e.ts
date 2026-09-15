import { test, expect } from '@playwright/test';

/**
 * A browser spec owned by the extension itself — the pattern a private
 * extension copies. Files under `apps/web/src/extensions/<id>/e2e/*.e2e.ts`
 * run in the `extensions` Playwright project with the shared authenticated
 * state (see playwright.config.ts); they import nothing from tests/, so the
 * extension folder stays self-contained.
 */
test('example: a note created through the extension API shows on its page', async ({ page, request }) => {
  await page.goto('/#/example');
  await expect(page.getByTestId('example-notes-page')).toBeVisible();

  const token = await page.evaluate(() => localStorage.getItem('greenhouse_access_token'));
  expect(token).toBeTruthy();
  const headers = { Authorization: `Bearer ${token}` };
  const body = `e2e-ext-${Date.now().toString(36)}`;
  const created = await request.post('/api/ext/example/notes', { headers, data: { body } });
  expect(created.status()).toBe(201);
  const { note } = (await created.json()) as { note: { id: number } };

  try {
    await page.reload();
    await expect(page.getByTestId('example-note-list')).toContainText(body);
  } finally {
    await request.delete(`/api/ext/example/notes/${note.id}`, { headers });
  }
});
