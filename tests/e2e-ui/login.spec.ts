import { test, expect } from '@playwright/test';
import { TEST_ACCOUNT } from './fixtures';

// These run logged-out — drop the shared authenticated storage state.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('auth', () => {
  test('shows the login screen when unauthenticated', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('login-submit')).toBeVisible();
    await expect(page.getByTestId('login-email')).toBeVisible();
    await expect(page.getByTestId('login-password')).toBeVisible();
  });

  test('rejects a wrong password and stays on the login screen', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('login-tab-team').click();
    await page.getByTestId('login-email').fill(TEST_ACCOUNT.email);
    await page.getByTestId('login-password').fill('definitely-the-wrong-password');
    await page.getByTestId('login-submit').click();

    await expect(page.getByText('Invalid email or password')).toBeVisible();
    await expect(page.getByTestId('login-submit')).toBeVisible(); // not navigated into the app
  });
});
