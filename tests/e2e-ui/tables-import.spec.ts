/**
 * CSV import (spec 20261011-tables-foundation §6, acceptance 8).
 *
 * The test super uploads a small CSV through the import wizard: two columns go
 * to existing fields (suggested by header), the third becomes a new date field
 * named in the mapping step. The dry run reports the one bad row, the import
 * writes the other two, and the records — values read the way the shared
 * cell-text coercer reads them (`¥1,200`, `50%`, `2024年3月7日`) — are checked
 * over the API.
 */

import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';

interface CreatedBase {
  base: { id: number };
  schema: { table: { id: number }; fields: Array<{ id: number; name: string }> };
}

async function json<T>(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  expect(response.ok(), `${response.url()} → ${response.status()}`).toBeTruthy();
  return (await response.json()) as T;
}

const CSV = ['Name,Amount,Due', 'Alpha,"¥1,200",2024/3/5', 'Beta,abc,2024-03-06', 'Gamma,50%,2024年3月7日', ''].join(
  '\r\n',
);

test.describe('tables import', () => {
  test('maps a CSV onto existing and new fields, reports the bad row and imports the rest', async ({
    page,
    api,
    runId,
  }) => {
    const created = await json<CreatedBase>(await api.post('/api/tables/bases', { data: { name: `${runId}-import` } }));
    const baseId = created.base.id;
    const tableId = created.schema.table.id;
    const name = created.schema.fields[0]!;
    expect(name.name).toBe('Name');

    try {
      const amount = await json<{ field: { id: number } }>(
        await api.post(`/api/tables/tables/${tableId}/fields`, { data: { name: 'Amount', type: 'number' } }),
      );
      const amountId = amount.field.id;

      // ── Upload ──
      await page.goto(`/#/tables/${baseId}/table/${tableId}`);
      await page.getByTestId('tables-import-open').click();
      const wizard = page.getByTestId('tables-import-dialog');
      await expect(wizard).toBeVisible();
      await page.getByTestId('tables-import-file').setInputFiles({
        name: `${runId}.csv`,
        mimeType: 'text/csv',
        buffer: Buffer.from(CSV, 'utf8'),
      });

      // ── Map: two columns match fields by header, the third becomes a new date field ──
      await expect(page.getByTestId('tables-import-mapping')).toBeVisible();
      await expect(wizard).toContainText(`${runId}.csv · 3 rows · 3 columns`);
      await expect(page.getByTestId('tables-import-destination-0')).toHaveValue(`field:${name.id}`);
      await expect(page.getByTestId('tables-import-destination-1')).toHaveValue(`field:${amountId}`);
      await expect(page.getByTestId('tables-import-destination-2')).toHaveValue('create');
      await page.getByTestId('tables-import-name-2').fill('Due date');
      await page.getByTestId('tables-import-type-2').selectOption('date');

      // ── Check: the server's dry run names the bad row ──
      await page.getByTestId('tables-import-check-button').click();
      const check = page.getByTestId('tables-import-check');
      await expect(check).toContainText('2 rows are ready to import');
      await expect(check).toContainText('1 rows will be skipped');
      const failures = check.getByTestId('tables-import-failures');
      await expect(failures).toContainText('Row 3');
      await expect(failures).toContainText('Amount: "abc" is not a number');

      // ── Import ──
      await page.getByTestId('tables-import-start').click();
      const result = page.getByTestId('tables-import-result');
      await expect(result).toContainText('Import finished');
      await expect(result).toContainText('2 records created');
      await expect(result).toContainText('1 rows skipped');
      await expect(result).toContainText('1 new fields added');
      await expect(result.getByTestId('tables-import-failures')).toContainText('Row 3');
      await page.getByTestId('tables-import-done').click();
      await expect(wizard).toBeHidden();

      // ── The new field and the two rows, over the API ──
      const schema = await json<{ fields: Array<{ id: number; name: string; type: string }> }>(
        await api.get(`/api/tables/tables/${tableId}/schema`),
      );
      const due = schema.fields.find((field) => field.name === 'Due date');
      expect(due?.type).toBe('date');
      const records = await json<{ records: Array<{ values: Record<string, unknown> }> }>(
        await api.post(`/api/tables/tables/${tableId}/records/query`, { data: {} }),
      );
      const rows = records.records
        .map((record) => ({
          name: record.values[String(name.id)],
          amount: record.values[String(amountId)],
          due: record.values[String(due!.id)],
        }))
        .sort((left, right) => String(left.name).localeCompare(String(right.name)));
      expect(rows).toEqual([
        { name: 'Alpha', amount: 1200, due: '2024-03-05' },
        { name: 'Gamma', amount: 0.5, due: '2024-03-07' },
      ]);

      // The grid shows them without a reload (the wizard asks the view to refetch).
      await expect(page.getByText('Gamma', { exact: true })).toBeVisible();
      await expect(page.getByText('Beta', { exact: true })).toHaveCount(0);
    } finally {
      await api.post(`/api/tables/bases/${baseId}/archive`);
    }
  });
});
