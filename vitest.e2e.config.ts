/**
 * Vitest configuration for E2E security tests.
 *
 * These tests run against a LIVE server and are not part of the normal
 * `pnpm test` workflow. Run manually:
 *
 *   # Terminal 1: Seed a real DB super identity, then start test server
 *   export E2E_SUPER_USER_ID="$(./node_modules/.bin/tsx tests/e2e/seed-users.ts seed)"
 *   API_PORT=3999 TOKEN_SIGNING_KEY=6666666666666666666666666666666666666666666666666666666666666666 pnpm api
 *
 *   # Terminal 2: Copy E2E_SUPER_USER_ID, then run e2e tests
 *   E2E_SUPER_USER_ID=copy-uuid-here API_PORT=3999 TOKEN_SIGNING_KEY=6666666666666666666666666666666666666666666666666666666666666666 pnpm test:e2e
 *
 * Or run everything in one command (server auto-starts):
 *   pnpm test:e2e:ci
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/e2e/**/*.e2e.test.ts'],
    // Longer timeout for real network requests + LLM calls
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Run sequentially — e2e tests may have ordering dependencies
    sequence: { concurrent: false },
    // Minimal parallel to avoid rate limiting
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
