import { test as setup, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { API_BASE, CLIENT_DATABASE } from '../../playwright.client.config';
export const ACCOUNT = { email: 'c1-client@test.local', password: 'ClientE2ePw123', nickname: 'Jim' };
setup('sign in to the universal client', async ({ page }) => {
  try {
    execFileSync(
      'pnpm',
      [
        'cli',
        'users',
        'create',
        '--email',
        ACCOUNT.email,
        '--password',
        ACCOUNT.password,
        '--nickname',
        ACCOUNT.nickname,
      ],
      {
        env: { ...process.env, DATABASE_URL: CLIENT_DATABASE },
        stdio: 'pipe',
      },
    );
  } catch (error) {
    const result = error as { stdout?: Buffer; stderr?: Buffer };
    if (!/already|exists|存在/i.test(String(result.stdout) + String(result.stderr))) throw error;
  }
  await page.goto('/');
  await page.getByTestId('login-email').fill(ACCOUNT.email);
  await page.getByTestId('login-password').fill(ACCOUNT.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  const token = await page.evaluate(
    () => Object.entries(localStorage).find(([key]) => key.startsWith('greenhouse_access_token'))?.[1] ?? '',
  );
  const locale = await page.request.put(`${API_BASE}/api/auth/me/preferences`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { locale: 'zh' },
  });
  expect(locale.ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  mkdirSync('tests/client-e2e/.auth', { recursive: true });
  await page.context().storageState({ path: 'tests/client-e2e/.auth/state.json' });
});
