import { test, expect } from '@playwright/test';
import { api, grantFeature, memberToken, ready } from '../../../tests/client-e2e/plugin-kit';

// Reference for a plugin's own browser test: real API, real station manifest, the derived entity list page.
test('Example notes: a note written through the plugin API shows on its entity list page', async ({ page }) => {
  await grantFeature(page, 'example');
  const body = `Plugin e2e note ${test.info().repeatEachIndex}`;
  await api(page.request, await memberToken(page), 'POST', '/api/ext/example/notes', { body });
  await ready(page, '/p/example/example-note');
  await expect(page.getByText(body, { exact: true }).first()).toBeVisible();
});
