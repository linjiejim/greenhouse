import { defineConfig, devices } from '@playwright/test';
// Parallel worktrees override these so their suites never share ports or a database.
export const CLIENT_DATABASE =
  process.env.CLIENT_E2E_DATABASE ?? 'postgresql://greenhouse:greenhouse@127.0.0.1:55450/gh4_client';
export const API_PORT = process.env.CLIENT_E2E_API_PORT ?? '18920';
export const WEB_PORT = process.env.CLIENT_E2E_WEB_PORT ?? '18921';
export const API_BASE = `http://localhost:${API_PORT}`;
const shared = {
  DATABASE_URL: CLIENT_DATABASE,
  TOKEN_SIGNING_KEY: '6666666666666666666666666666666666666666666666666666666666666666',
  PROVIDER_TOKEN_ENCRYPTION_KEY: '7777777777777777777777777777777777777777777777777777777777777777',
  LLM_BASE_URL: 'http://127.0.0.1:1/v1',
  LLM_API_KEY: 'sk-e2e-fake',
  LLM_MODEL: 'e2e-fake-model',
};
export default defineConfig({
  testDir: './tests/client-e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
  use: { baseURL: `http://localhost:${WEB_PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'client',
      testMatch: /.*\.e2e\.ts/,
      use: { ...devices['Desktop Chrome'], storageState: 'tests/client-e2e/.auth/state.json' },
      dependencies: ['setup'],
    },
  ],
  webServer: [
    {
      command: 'pnpm api',
      url: `${API_BASE}/health`,
      env: { ...shared, API_PORT, CORS_ALLOWED_ORIGINS: `http://localhost:${WEB_PORT}` },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `cd apps/client && npx expo start --web --port ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}`,
      env: { EXPO_PUBLIC_API_BASE_URL: API_BASE, CI: '1' },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
