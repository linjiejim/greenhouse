import { test, expect } from '@playwright/test';
import { api, grantFeature, memberToken, openHosted, ready } from '../../../tests/client-e2e/plugin-kit';

// Reference for a plugin's own browser test: real API, real station manifest, the derived entity list page.
test('Example notes: a note written through the plugin API shows on its entity list page', async ({ page }) => {
  await grantFeature(page, 'example');
  const body = `Plugin e2e note ${test.info().repeatEachIndex}`;
  await api(page.request, await memberToken(page), 'POST', '/api/ext/example/notes', { body });
  await ready(page, '/p/example/example-note');
  await expect(page.getByText(body, { exact: true }).first()).toBeVisible();
});

// An embed needs the hosted client (same origin as the embed); see openHosted.
test('Example embed: the bridge hands over the member, and the embed token reads the member directory', async ({
  page,
}) => {
  await grantFeature(page, 'example');
  await openHosted(page, '/p/example/example-embed');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#status')).toContainText('Hello, Jim');
  // the frame is hidden only until its document loads (no white flash on a dark host)
  await expect(page.locator('iframe')).toBeVisible();
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(frame.locator('#colleagues')).toContainText(/\d+ people on this station/);
});

// Plugin objects, end to end in a real frame: upload target → PUT (no Bearer) → size check →
// an inline URL the frame's CSP lets an <img> load.
test('Example embed: a picture goes into the plugin object store and shows inline', async ({ page }) => {
  await grantFeature(page, 'example');
  await openHosted(page, '/p/example/example-embed');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#status')).toContainText('Hello');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await frame.locator('#picture-file').setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
  await expect(frame.locator('#picture-status')).toHaveText('Attached to a new note.');
  const preview = frame.locator('#picture-preview');
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);
});
