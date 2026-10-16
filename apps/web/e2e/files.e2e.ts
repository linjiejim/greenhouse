import { expect, test } from '@playwright/test';
import { composer, open } from './fixtures';

/** A 2×2 PNG: real image bytes (the API checks the type from the content). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDK+mmyQAAAABJRU5ErkJggg==',
  'base64',
);

test('attachments: a picture shows inline and a file downloads', async ({ page }) => {
  await open(page, '/#/c/new');
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'dot.png', mimeType: 'image/png', buffer: PNG },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello notes') },
  ]);
  await expect(page.getByRole('list', { name: '附件' }).getByText('notes.txt')).toBeVisible();
  await composer(page).fill('see the files');
  await composer(page).press('Enter');
  await expect(page).toHaveURL(/#\/c\/cnv_/);
  const image = page.locator('.app-message-image img');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(2);
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载「notes.txt」' }).click();
  expect((await download).suggestedFilename()).toBe('notes.txt');
});

test('my picture and the workspace logo', async ({ page, browser }) => {
  await open(page, '/#/settings/account');
  await page.getByRole('form', { name: '个人资料' }).locator('input[type="file"]').setInputFiles({
    name: 'me.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  await expect(page.getByRole('button', { name: '账户' }).locator('img')).toBeVisible();

  await page.goto('/#/admin/branding');
  await page.getByRole('form', { name: '品牌' }).locator('input[type="file"]').setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  await expect(page.locator('.app-rail-logo')).toBeVisible();
  const visitor = await browser.newContext({ storageState: { cookies: [], origins: [] }, locale: 'zh-CN' });
  const signIn = await visitor.newPage();
  await signIn.goto('/');
  await expect(signIn.locator('.app-login-logo')).toBeVisible();
  await expect
    .poll(() => signIn.locator('.app-login-logo').evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBe(2);
  await visitor.close();
  await page.getByRole('form', { name: '品牌' }).getByRole('button', { name: '移除' }).click();
  await expect(page.locator('.app-rail-logo')).toHaveCount(0);
});
