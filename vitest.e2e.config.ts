/**
 * Vitest configuration for E2E security tests.
 *
 * These tests run against a LIVE server and are not part of the normal
 * `pnpm test` workflow. Run manually:
 *
 *   # Terminal 1: Start test server
 *   API_PORT=3999 ACCESS_PASSWORD=test-secret pnpm api
 *
 *   # Terminal 2: Run e2e tests
 *   API_PORT=3999 ACCESS_PASSWORD=test-secret pnpm test:e2e
 *
 * Or run everything in one command (server auto-starts):
 *   pnpm test:e2e:full
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/e2e/**/*.e2e.test.ts"],
    // Longer timeout for real network requests + LLM calls
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Run sequentially — e2e tests may have ordering dependencies
    sequence: { concurrent: false },
    // Minimal parallel to avoid rate limiting
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
