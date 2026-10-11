/**
 * A Tables walkthrough that fails on any failed request: load the app, open a
 * Base, a record through `?record=` (fields + activity), the dashboard, the
 * automations dialog, sharing and the audit log. Each failed request shows up
 * as a "Failed to load resource" console error — the integrator saw two 404s
 * that way (the optional release-notes files, asked for on every load) — so the
 * walkthrough lists every 4xx / 5xx response from the app's own origin and
 * expects none.
 */
import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

async function post<T>(api: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await api.post(`/api/tables${path}`, { data });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return (await response.json()) as T;
}

/** Every same-origin response with an error status (`/api`, `/public`, assets), as `404 GET /public/...`. */
function watchFailedRequests(page: Page, origin: string): string[] {
  const failures: string[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin !== origin || response.status() < 400) return;
    failures.push(`${response.status()} ${response.request().method()} ${url.pathname}${url.search}`);
  });
  return failures;
}

test.describe('tables walkthrough', () => {
  test('opens the app, a Base, a record, its dashboard and its dialogs without a failed request', async ({
    page,
    api,
    runId,
    baseURL,
  }) => {
    const created = await post<{
      base: { id: number };
      schema: { table: { id: number }; fields: Array<{ id: number }> };
    }>(api, '/bases', { name: `${runId}-walkthrough`, visibility: 'private' });
    const baseId = created.base.id;
    const tableId = created.schema.table.id;
    const nameId = created.schema.fields[0]!.id;

    try {
      const field = async (name: string, type: string, config?: unknown) =>
        (await post<{ field: { id: number } }>(api, `/tables/${tableId}/fields`, { name, type, config })).field.id;
      const stageId = await field('Stage', 'single_select', {
        options: [
          { id: 'open', label: 'Open' },
          { id: 'won', label: 'Won' },
        ],
      });
      const amountId = await field('Amount', 'number');
      await field('Owner', 'user');
      await field('Files', 'attachment');
      const { record } = await post<{ record: { id: number } }>(api, `/tables/${tableId}/records`, {
        values: { [nameId]: `${runId}-acme`, [stageId]: 'won', [amountId]: 760000 },
      });
      const { dashboard } = await post<{ dashboard: { id: number } }>(api, `/bases/${baseId}/dashboards`, {
        name: `${runId}-overview`,
      });
      await post(api, `/dashboards/${dashboard.id}/widgets`, {
        title: 'Deals',
        tableId,
        config: { card: { kind: 'kpi', source: { tableId }, aggregate: { operation: 'count' } } },
        layout: { x: 0, y: 0, w: 4, h: 3 },
      });

      const failures = watchFailedRequests(page, new URL(baseURL!).origin);

      // The app as it loads after login, then the table, then one record through the shared deep link.
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await page.goto(`/#/tables/${baseId}/table/${tableId}`);
      await expect(page.getByText(`${runId}-acme`).first()).toBeVisible();
      await expect(page.getByText('760,000').first()).toBeVisible();
      await page.goto(`/#/tables/${baseId}/table/${tableId}?record=${record.id}`);
      const drawer = page.getByRole('dialog');
      await expect(drawer).toBeVisible();
      await drawer.getByRole('tab', { name: 'Activity' }).click();
      await expect(drawer.getByText('created this record').first()).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();

      // The dashboard.
      await page.goto(`/#/tables/${baseId}/dashboard/${dashboard.id}`);
      await expect(page.getByTestId('table-card-kpi')).toHaveText('1');

      // Builder and owner dialogs from the Base header.
      for (const name of ['Automations', 'Activity', 'Share']) {
        await page.getByRole('button', { name, exact: true }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        // Let the dialog's reads settle before closing it.
        await page.waitForLoadState('networkidle');
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
      }

      await page.waitForLoadState('networkidle');
      expect(failures).toEqual([]);
    } finally {
      await api.post(`/api/tables/bases/${baseId}/archive`);
    }
  });
});
