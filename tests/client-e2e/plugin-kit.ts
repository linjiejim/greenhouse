/**
 * Helpers for a plugin's own browser tests (`plugins/<id>/e2e/*.e2e.ts`, the `plugins` Playwright
 * project). They run against the real API as the member auth.setup.ts signs in (a super).
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE } from '../../playwright.client.config';

/** The signed-in member's bearer token, read from the client's storage. */
export async function memberToken(page: Page): Promise<string> {
  if (page.url() === 'about:blank') await page.goto('/');
  const token = await page.evaluate(
    () => Object.entries(localStorage).find(([key]) => key.startsWith('greenhouse_access_token'))?.[1] ?? '',
  );
  expect(token, 'signed-in member token').not.toBe('');
  return token;
}

/** A JSON call to the API as the bearer of `token`. */
export async function api(request: APIRequestContext, token: string, method: string, path: string, data?: unknown) {
  const response = await request.fetch(`${API_BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    data,
  });
  expect(response.ok(), `${method} ${path} → ${response.status()}`).toBeTruthy();
  return response.json();
}

/** Switch a plugin feature flag on for the signed-in member (a super; most plugins default flags off). */
export async function grantFeature(page: Page, feature: string): Promise<void> {
  const token = await memberToken(page);
  const me = await api(page.request, token, 'GET', '/api/auth/me');
  const id = me.user?.id ?? me.id;
  await api(page.request, token, 'PUT', `/api/admin/users/${id}/features`, {
    feature,
    enabled: true,
  });
}

/** Open a client route and wait for the startup splash to leave. */
export async function ready(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByTestId('startup-splash')).toHaveCount(0);
}
