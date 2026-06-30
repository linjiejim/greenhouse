/**
 * Auth setup project — runs once before the authenticated specs.
 *
 * 1. Ensures a super test account exists. The API deliberately forbids creating
 *    supers, so we use the `admin:create` CLI (writes straight to the DB).
 *    Idempotent: a second run hits "already exists" and is ignored.
 * 2. Logs in through the real login UI (exercising the login flow itself).
 * 3. Saves the authenticated storage state (tokens live in localStorage) for reuse.
 */
import { test as setup, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { TEST_ACCOUNT, AUTH_STATE } from './fixtures';

setup('create account + authenticate', async ({ page }) => {
  // 1. Ensure the super account exists (idempotent).
  try {
    execFileSync(
      'pnpm',
      [
        'admin:create',
        '--email',
        TEST_ACCOUNT.email,
        '--password',
        TEST_ACCOUNT.password,
        '--nickname',
        TEST_ACCOUNT.nickname,
      ],
      { stdio: 'pipe' },
    );
  } catch {
    // Non-zero exit means the account already exists — that's fine.
  }

  // 2. Log in via the real UI.
  await page.goto('/');
  await page.getByTestId('login-tab-team').click();
  await page.getByTestId('login-email').fill(TEST_ACCOUNT.email);
  await page.getByTestId('login-password').fill(TEST_ACCOUNT.password);
  await page.getByTestId('login-submit').click();

  // 3. Wait for the authenticated app shell, then persist storage state.
  await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 20_000 });

  fs.mkdirSync(path.dirname(AUTH_STATE), { recursive: true });
  await page.context().storageState({ path: AUTH_STATE });
});
