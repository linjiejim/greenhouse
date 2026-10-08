import { test, expect } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

test('launch mark settles once and a ready app does not wait for the animation', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/bootstrap', async (route) => {
    await gate;
    await route.fulfill({ json: { product_name: null, logo: null, theme_tokens: null } });
  });
  await page.goto('/');
  const splash = page.getByTestId('launch-screen');
  await expect(splash).toBeVisible();
  await expect(splash.locator('.greenhouse-seed')).toHaveCSS('animation-iteration-count', '1');
  release();
  await expect(page.getByTestId('login-email')).toBeVisible();
  await expect(splash).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('600 16px Nunito'))).toBe(true);
  await expect(page.getByTestId('login-email')).toHaveCSS('font-family', /Nunito/);
});

test('reduced motion shows a static mark and failed bootstrap still reaches login', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/bootstrap', async (route) => {
    await gate;
    await route.abort();
  });
  await page.goto('/');
  await expect(page.getByTestId('launch-screen').locator('.greenhouse-seed')).toHaveCSS('animation-name', 'none');
  release();
  await expect(page.getByTestId('login-email')).toBeVisible();
});

test('workspace branding still wins over the product mark and font', async ({ page }) => {
  const customLogo =
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="green"/></svg>',
    );
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      json: { product_name: 'Garden team', logo: customLogo, theme_tokens: { fontSans: 'Georgia, serif' } },
    }),
  );
  await page.goto('/');
  await expect(page.getByTestId('login-email')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Garden team' })).toHaveAttribute('src', customLogo);
  await expect(page.getByTestId('login-email')).toHaveCSS('font-family', /Georgia/);
});
