/**
 * Shared fixtures for the browser e2e suite.
 *
 * - `runId`: a per-test unique prefix (`e2e-<worker>-<ts>`) for any data the test
 *   creates, so writes against the shared dev DB never collide and can be swept up.
 * - `api`: an APIRequestContext pre-authenticated as the test super, for setup/teardown
 *   shortcuts and assertions (the access token is read out of the saved storage state).
 */
import { test as base, expect, type APIRequestContext } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export const TEST_ACCOUNT = {
  email: 'e2e-playwright@test.local',
  password: 'E2ePlaywrightPw1',
  nickname: 'E2E-Playwright',
};

export const AUTH_STATE = path.join('tests', 'e2e-ui', '.auth', 'state.json');

/** Pull the access token the web app stashed in localStorage out of the storage-state file. */
export function readAccessToken(): string {
  const state = JSON.parse(fs.readFileSync(AUTH_STATE, 'utf8')) as {
    origins?: Array<{ localStorage?: Array<{ name: string; value: string }> }>;
  };
  for (const origin of state.origins ?? []) {
    const hit = origin.localStorage?.find((e) => e.name === 'greenhouse_access_token');
    if (hit?.value) return hit.value;
  }
  throw new Error(`No greenhouse_access_token in ${AUTH_STATE} — did auth.setup run?`);
}

export const test = base.extend<{ runId: string; api: APIRequestContext }>({
  runId: async ({}, use, testInfo) => {
    // Date.now() is fine here (not a deterministic-replay context).
    await use(`e2e-${testInfo.workerIndex}-${Date.now().toString(36)}`);
  },
  api: async ({ playwright, baseURL }, use) => {
    const ctx = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { Authorization: `Bearer ${readAccessToken()}` },
    });
    await use(ctx);
    await ctx.dispose();
  },
});

export { expect };
