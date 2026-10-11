import { test, expect } from './fixtures';

/**
 * Tables · formulas and lookups (Phase 0 acceptance 10): a formula typed as
 * text with field autocomplete, `IF({数量} > 10, "大单", "小单")` and
 * `DATEDIFF({截止}, {开始}, "days")` computed in the grid, a parse error shown
 * in place, and a lookup showing the linked record's value.
 */
test.describe('tables formulas', () => {
  test('writes formulas as text and shows a lookup', async ({ page, api, runId }) => {
    const created = await api.post('/api/tables/bases', { data: { name: `${runId} Deals` } });
    expect(created.ok()).toBeTruthy();
    const { base, schema } = (await created.json()) as {
      base: { id: number };
      schema: { table: { id: number }; fields: Array<{ id: number; name: string }> };
    };
    const dealsId = schema.table.id;
    const dealName = schema.fields[0]!.id;

    try {
      const field = async (tableId: number, name: string, type: string, config?: object) => {
        const response = await api.post(`/api/tables/tables/${tableId}/fields`, { data: { name, type, config } });
        expect(response.ok()).toBeTruthy();
        return ((await response.json()) as { field: { id: number } }).field.id;
      };
      const record = async (tableId: number, values: Record<string, unknown>) => {
        const response = await api.post(`/api/tables/tables/${tableId}/records`, { data: { values } });
        expect(response.ok()).toBeTruthy();
        return ((await response.json()) as { record: { id: number } }).record.id;
      };

      const customersResponse = await api.post(`/api/tables/bases/${base.id}/tables`, {
        data: { name: 'Customers' },
      });
      expect(customersResponse.ok()).toBeTruthy();
      const customers = (await customersResponse.json()) as {
        table: { id: number };
        fields: Array<{ id: number }>;
      };
      const acme = await record(customers.table.id, { [customers.fields[0]!.id]: 'Acme Corp' });

      const qty = await field(dealsId, '数量', 'number');
      const start = await field(dealsId, '开始', 'date');
      const due = await field(dealsId, '截止', 'date');
      const customer = await field(dealsId, 'Customer', 'relation', {
        relation: { targetTableId: customers.table.id, multiple: true },
      });
      await record(dealsId, {
        [dealName]: 'Big deal',
        [qty]: 12,
        [start]: '2026-01-31',
        [due]: '2026-03-15',
        [customer]: [acme],
      });
      await record(dealsId, { [dealName]: 'Small deal', [qty]: 3 });

      await page.goto(`/#/tables/${base.id}/table/${dealsId}`);
      await expect(page.getByText('Big deal')).toBeVisible();

      // 1. IF formula, the field picked from the autocomplete.
      await page.getByRole('button', { name: 'Add field' }).click();
      let dialog = page.getByRole('dialog');
      await dialog.getByLabel('Name').fill('Size');
      await dialog.locator('select').first().selectOption('formula');
      const editor = dialog.getByTestId('formula-editor-input');
      await editor.click();
      await page.keyboard.type('IF({数');
      await expect(dialog.getByTestId('formula-suggestions')).toContainText('{数量}');
      await page.keyboard.press('Enter');
      await expect(editor).toHaveValue('IF({数量}');
      await page.keyboard.type(' > 10, "大单", "小单")');
      await expect(dialog.getByTestId('formula-result-type')).toHaveText('Returns Text');
      await dialog.getByRole('button', { name: 'Save field' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('cell', { name: '大单' })).toBeVisible();
      await expect(page.getByRole('cell', { name: '小单' })).toBeVisible();

      // 2. A parse error is shown where it is and blocks saving; DATEDIFF then computes.
      await page.getByRole('button', { name: 'Add field' }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Name').fill('Days');
      await dialog.locator('select').first().selectOption('formula');
      await dialog.getByTestId('formula-editor-input').fill('DATEDIFF({截止}, {Nope}, "days")');
      await expect(dialog.getByTestId('formula-error')).toContainText('There is no field named Nope.');
      await expect(dialog.getByTestId('formula-error-mark')).toHaveText('{Nope}');
      await dialog.getByRole('button', { name: 'Save field' }).click();
      await expect(dialog.getByText('Fix the formula before saving', { exact: false })).toBeVisible();
      await dialog.getByTestId('formula-editor-input').fill('DATEDIFF({截止}, {开始}, "days")');
      await expect(dialog.getByTestId('formula-result-type')).toHaveText('Returns Number');
      await dialog.getByRole('button', { name: 'Save field' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('cell', { name: '43', exact: true })).toBeVisible();

      // 3. A lookup through the relation shows the linked customer's name.
      await page.getByRole('button', { name: 'Add field' }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Name').fill('Company');
      await dialog.locator('select').first().selectOption('lookup');
      await dialog.getByLabel('Relation field').selectOption({ label: 'Customer' });
      await dialog.getByLabel('Target field').selectOption({ label: 'Name' });
      await dialog.getByRole('button', { name: 'Save field' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('cell', { name: 'Acme Corp' })).toBeVisible();
    } finally {
      await api.post(`/api/tables/bases/${base.id}/archive`);
    }
  });
});
