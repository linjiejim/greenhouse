import { test, expect } from '@playwright/test';

test('declarative entity list opens a detail and saves an edit', async ({ page, request }) => {
  await page.goto('/#/ext/example/example-note');
  const token = await page.evaluate(() => localStorage.getItem('greenhouse_access_token'));
  const headers = { Authorization: `Bearer ${token}` };
  const manifest = await (await request.get('/api/extensions', { headers })).json();
  const plugin = manifest.plugins.find((p: { id: string }) => p.id === 'example');
  const list = plugin.pages.find((p: { kind: string }) => p.kind === 'entity-list');
  const text = `e2e-w4-${Date.now()}`;
  const created = await request.post('/api/ext/example/entities/note', { headers, data: { body: text } });
  expect(created.status()).toBe(201);
  const record = await created.json();
  try {
    await page.goto(`/#/ext/example/${list.id}`);
    await page.getByRole('link', { name: text, exact: true }).click();
    await expect(page).toHaveURL(/\/ext\/example\/.*\/[^/]+$/);
    const detail = page.getByRole('dialog');
    await expect(detail).toContainText(text);
    await detail.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByTestId('ext-example-example.note-field-body').fill(`${text}-edited`);
    await page.getByTestId('ext-example-example.note-submit').click();
    await expect(page.getByRole('dialog')).toContainText(`${text}-edited`);
  } finally {
    await request.delete(`/api/ext/example/entities/note/${record.id}`, { headers });
  }
});

test('declarative settings form saves only its declared keys', async ({ page, request }) => {
  await page.goto('/#/ext/example/example-settings');
  const token = await page.evaluate(() => localStorage.getItem('greenhouse_access_token'));
  const headers = { Authorization: `Bearer ${token}` };
  const settings = (await (await request.get('/api/admin/settings', { headers })).json()).settings;
  const before = settings.find((s: { key: string }) => s.key === 'example.greeting');
  try {
    await expect(page.getByRole('textbox', { name: 'Greeting', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveCount(1);
    await page.getByRole('textbox', { name: 'Greeting', exact: true }).fill('e2e W4 greeting');
    const saving = page.waitForRequest((req) => req.url().endsWith('/api/admin/settings') && req.method() === 'PUT');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await saving).postDataJSON()).toEqual({ values: { 'example.greeting': 'e2e W4 greeting' } });
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Greeting', exact: true })).toHaveValue('e2e W4 greeting');
  } finally {
    await request.put('/api/admin/settings', {
      headers,
      data: { values: { 'example.greeting': before?.source === 'db' ? before.value : null } },
    });
  }
});

test('embed initializes, follows theme without reload, refreshes, drafts and navigates', async ({ page }) => {
  await page.goto('/#/ext/example/example-embed');
  const iframe = page.locator('[data-testid="extension-embed-host"] iframe');
  const frame = page.frameLocator('[data-testid="extension-embed-host"] iframe');
  await expect(frame.locator('#status')).toContainText('Your notes stay personal');
  const src = await iframe.getAttribute('src');
  await page.evaluate(() => {
    document.documentElement.classList.add('dark-theme');
    document.documentElement.style.setProperty('--t-accent', '#123456');
  });
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect
    .poll(() => frame.locator('html').evaluate((el) => (el as HTMLElement).style.getPropertyValue('--t-accent')))
    .toBe('#123456');
  expect(await iframe.getAttribute('src')).toBe(src);
  await frame.getByRole('button', { name: 'Refresh token' }).click();
  await expect(frame.locator('#status')).toHaveText('Token refreshed');
  await frame.getByRole('button', { name: 'Ask the assistant' }).click();
  await expect(page.getByTestId('chat-input').last()).toHaveValue('Help me organize my notes');
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();
  await frame.getByRole('button', { name: 'Open notes' }).click();
  await expect(page).toHaveURL(/#\/ext\/example\/example-note$/);
  await expect(page.getByTestId('extension-manifest-page')).toBeVisible();
});

test('embed bearer stays within the plugin and basic member read', async ({ page, request }) => {
  await page.goto('/#/ext/example/example-embed');
  const full = await page.evaluate(() => localStorage.getItem('greenhouse_access_token'));
  const minted = await request.post('/api/ext-ui/token', {
    headers: { Authorization: `Bearer ${full}` },
    data: { plugin: 'example' },
  });
  expect(minted.status()).toBe(200);
  const { token } = await minted.json(),
    headers = { Authorization: `Bearer ${token}` };
  expect((await request.get('/api/ext/example/entities/note', { headers })).status()).toBe(200);
  expect((await request.get('/api/me', { headers })).status()).toBe(200);
  for (const path of ['/api/ext/other/entities/note', '/api/admin/users', '/api/auth/me', '/api/me/preferences'])
    expect((await request.get(path, { headers })).status()).toBe(403);
  expect((await request.patch('/api/me', { headers, data: {} })).status()).toBe(403);
});
