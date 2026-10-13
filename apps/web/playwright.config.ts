import { defineConfig, devices } from '@playwright/test';
import { E2E } from './e2e/env';

/**
 * The web app against a real API and database, with a deterministic fake model. The
 * database (greenhouse_v2_e2e by default) is reset before every run.
 */
const root = new URL('../..', import.meta.url).pathname;
const apiEnv = [
  `GREENHOUSE_ENV_FILE=/dev/null`,
  `NODE_ENV=development`,
  `PORT=${E2E.apiPort}`,
  `PUBLIC_URL=http://127.0.0.1:${E2E.webPort}`,
  `DATABASE_URL=${E2E.databaseUrl}`,
  `TOKEN_SIGNING_KEY=${'a'.repeat(64)}`,
  `PROVIDER_TOKEN_ENCRYPTION_KEY=${'b'.repeat(64)}`,
  `LLM_PROVIDER=openai-compatible`,
  `LLM_BASE_URL=http://127.0.0.1:${E2E.llmPort}/v1`,
  `LLM_API_KEY=sk-e2e`,
  `LLM_MODEL=fake`,
  `LOG_LEVEL=warn`,
].join(' ');

export default defineConfig({
  testDir: './e2e',
  // *.e2e.ts, not *.spec.ts: the vitest unit project collects every *.spec.ts.
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${E2E.webPort}`,
    trace: 'retain-on-failure',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts$/ },
    {
      name: 'desktop',
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        // Signed in as Lin unless a test says otherwise (e2e/auth.setup.ts).
        storageState: 'e2e/.auth/lin.json',
      },
    },
  ],
  webServer: [
    {
      command: `node apps/web/e2e/fake-llm.mjs ${E2E.llmPort}`,
      cwd: root,
      url: `http://127.0.0.1:${E2E.llmPort}/v1/models`,
      reuseExistingServer: false,
    },
    {
      // Reset and seed the database first, so every run starts the same.
      command: `node --import tsx apps/web/e2e/seed.mts && ${apiEnv} node --import tsx apps/api/src/index.ts`,
      cwd: root,
      url: `http://127.0.0.1:${E2E.apiPort}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `GREENHOUSE_API=http://127.0.0.1:${E2E.apiPort} WEB_PORT=${E2E.webPort} pnpm --filter @greenhouse/web exec vite --host 127.0.0.1`,
      cwd: root,
      url: `http://127.0.0.1:${E2E.webPort}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
