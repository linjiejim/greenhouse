/**
 * Playwright config — browser e2e for core user flows (UI layer).
 *
 * Complements:
 *   - `pnpm test`        (vitest unit)
 *   - `pnpm test:e2e`    (vitest API-level security suite, no browser)
 * This suite drives the real app in Chromium and asserts on the rendered UI.
 *
 * Run:
 *   pnpm test:e2e:ui            # headless
 *   pnpm test:e2e:ui --ui      # interactive UI mode
 *   pnpm exec playwright show-report
 *
 * Auth: `auth.setup.ts` creates a throwaway super test account (via the
 * `admin:create` CLI — the API forbids creating supers) and logs in through the
 * real login UI, saving the authenticated storage state for the other specs.
 */

import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3100';

export default defineConfig({
  testDir: './tests/e2e-ui',
  // Shared dev DB + a single dev server → run serially to avoid write races.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'tests/e2e-ui/.auth/state.json' },
      dependencies: ['setup'],
    },
  ],

  // Auto-start the dev server; reuse one already running locally.
  // `/health` is proxied by Vite to the API, so this also waits for the API (:3101),
  // not just the web server (:3100).
  webServer: {
    command: 'pnpm dev',
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
