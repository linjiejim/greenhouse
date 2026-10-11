/**
 * Tables dashboards (Phase 0 acceptance 7): a stacked bar chart bucketed by
 * month, a pivot table, and a date-range and a person filter working together;
 * clicking a bar opens the records behind it, and a record opens in its table.
 *
 * Data is seeded through the API; the browser runs in Asia/Shanghai so the
 * month buckets and "this month" are computed in a fixed zone.
 */
import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

const ZONE = 'Asia/Shanghai';
test.use({ timezoneId: ZONE });

/** Today (and N days earlier) as YYYY-MM-DD in the browser's zone. */
function zonedDay(daysAgo = 0): string {
  const instant = new Date(Date.now() - daysAgo * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    instant,
  );
}

async function post<T>(api: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await api.post(`/api/tables${path}`, { data });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return (await response.json()) as T;
}

async function seed(api: APIRequestContext, runId: string) {
  const users = (await (await api.get('/api/tables/meta/users')).json()) as {
    users: Array<{ id: string; email: string; nickname: string }>;
  };
  const me = users.users.find((user) => user.email === 'e2e-playwright@test.local');
  expect(me, 'the e2e account is listed').toBeTruthy();

  const created = await post<{
    base: { id: number };
    schema: { table: { id: number }; fields: Array<{ id: number }> };
  }>(api, '/bases', { name: `${runId}-sales`, visibility: 'private' });
  const baseId = created.base.id;
  const tableId = created.schema.table.id;
  const nameId = created.schema.fields[0]!.id;
  const field = async (name: string, type: string, config?: unknown) =>
    (
      await post<{ field: { id: number } }>(api, `/tables/${tableId}/fields`, {
        name,
        type,
        ...(config ? { config } : {}),
      })
    ).field.id;
  const stageId = await field('Stage', 'single_select', {
    options: [
      { id: 'open', label: 'Open' },
      { id: 'won', label: 'Won' },
    ],
  });
  const signedId = await field('Signed', 'date');
  const repId = await field('Rep', 'user');

  const today = zonedDay();
  const earlier = zonedDay(45);
  const records: Record<string, number> = {};
  for (const [name, stage, signed, rep] of [
    ['Alpha', 'won', today, me!.id],
    ['Bravo', 'open', today, me!.id],
    ['Charlie', 'won', today, null],
    ['Delta', 'won', earlier, me!.id],
  ] as const) {
    const values: Record<string, unknown> = { [nameId]: name, [stageId]: stage, [signedId]: signed };
    if (rep) values[repId] = rep;
    records[name] = (await post<{ record: { id: number } }>(api, `/tables/${tableId}/records`, { values })).record.id;
  }

  const { dashboard } = await post<{ dashboard: { id: number } }>(api, `/bases/${baseId}/dashboards`, {
    name: `${runId}-pipeline`,
    config: {
      version: 1,
      filters: [
        { id: 'period', label: 'Period', kind: 'date_range', targets: [{ tableId, fieldId: signedId }] },
        { id: 'rep', label: 'Rep', kind: 'user', targets: [{ tableId, fieldId: repId }] },
      ],
    },
  });
  const widget = (title: string, card: unknown, layout: unknown) =>
    post(api, `/dashboards/${dashboard.id}/widgets`, { title, tableId, config: { card }, layout });
  await widget(
    'Deals',
    { kind: 'kpi', source: { tableId }, aggregate: { operation: 'count' } },
    { x: 0, y: 0, w: 3, h: 2 },
  );
  await widget(
    'Monthly by stage',
    {
      kind: 'chart',
      source: { tableId },
      aggregate: {
        operation: 'count',
        groupBy: { fieldId: signedId, dateBucket: 'month' },
        series: { fieldId: stageId },
      },
      chart: { type: 'bar', stacked: true },
    },
    { x: 0, y: 2, w: 6, h: 6 },
  );
  await widget(
    'Stage by rep',
    {
      kind: 'pivot',
      source: { tableId },
      aggregate: { operation: 'count', groupBy: { fieldId: stageId }, series: { fieldId: repId } },
    },
    { x: 6, y: 2, w: 6, h: 6 },
  );
  return { baseId, tableId, dashboardId: dashboard.id, me: me!, records };
}

test.describe('tables dashboards', () => {
  test('monthly stacked chart, pivot and filters together; a bar opens its records', async ({ page, api, runId }) => {
    const seeded = await seed(api, runId);
    try {
      await page.goto(`/#/tables/${seeded.baseId}/dashboard/${seeded.dashboardId}`);
      const kpi = page.getByTestId('table-card-kpi');
      await expect(kpi).toHaveText('4');
      const pivot = page.locator('table', { hasText: 'Stage' }).first();
      await expect(pivot).toContainText('Won');
      await expect(pivot).toContainText(seeded.me.nickname);

      // Date range: this month (in Shanghai) drops Delta.
      const bar = page.getByTestId('dashboard-filter-bar');
      await bar.getByLabel('Period').selectOption('this_month');
      await expect(kpi).toHaveText('3');
      // Person: me drops Charlie. Both filters apply to every widget at once.
      await bar.getByLabel('Rep').selectOption('$me');
      await expect(kpi).toHaveText('2');
      await expect(page.getByRole('button', { name: `Show records for Won · ${seeded.me.nickname}` })).toHaveText('1');

      // Click the (single, stacked) bar: the first stack segment is "Open" → Bravo.
      const canvas = page
        .locator('[data-testid^="dashboard-widget-"]', { hasText: 'Monthly by stage' })
        .locator('canvas');
      await expect(canvas).toBeVisible();
      const drawer = page.getByTestId('dashboard-drilldown');
      await expect(async () => {
        const box = await canvas.boundingBox();
        expect(box).toBeTruthy();
        await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
        await expect(drawer).toBeVisible({ timeout: 1_500 });
      }).toPass({ timeout: 15_000 });
      await expect(drawer).toContainText('Bravo');
      await expect(drawer).not.toContainText('Alpha');
      await expect(page.getByRole('dialog').getByText(/Monthly by stage: .* · Open/)).toBeVisible();

      // The drilled record opens in its table.
      await drawer.getByRole('button', { name: 'Open Bravo' }).click();
      await expect(page).toHaveURL(
        new RegExp(`#/tables/${seeded.baseId}/table/${seeded.tableId}\\?record=${seeded.records.Bravo}`),
      );
    } finally {
      // Bases archive rather than delete; archiving keeps the shared dev DB's Base list clean.
      await api.post(`/api/tables/bases/${seeded.baseId}/archive`);
    }
  });
});
