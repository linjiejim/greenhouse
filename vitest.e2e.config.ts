/**
 * Vitest configuration for E2E security tests.
 *
 * These tests run against a LIVE server and are not part of the normal
 * `pnpm test` workflow.
 *
 * One command (boots the API + a stubbed LLM, then runs the suite — this is
 * exactly what CI's `e2e` job runs):
 *
 *   pnpm test:e2e:ci
 *
 * Or drive a server yourself (e.g. with a real LLM key, to exercise the
 * content-dependent assertions that `test:e2e:ci` skips via E2E_NO_LLM):
 *
 *   # Terminal 1: Start test server
 *   API_PORT=3999 ACCESS_PASSWORD=test-secret TOKEN_SIGNING_KEY=test-secret pnpm api
 *
 *   # Terminal 2: Run e2e tests
 *   API_PORT=3999 ACCESS_PASSWORD=test-secret pnpm test:e2e
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
