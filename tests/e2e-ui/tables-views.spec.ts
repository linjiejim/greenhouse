/**
 * Tables views (Phase 0 slice V, acceptance 4): create a kanban view in the
 * UI, drag a card to another lane with a real mouse, and check the change is
 * persisted — the drag is pointer events through the shared sensor, so this is
 * the honest test (CDP's drag API would skip exactly what can break).
 */
import { test, expect } from './fixtures';

interface CreatedBase {
  base: { id: number };
  schema: { table: { id: number }; fields: Array<{ id: number }> };
}

test.describe('tables views', () => {
  test('drags a kanban card to another lane and keeps it there', async ({ page, api, runId }) => {
    const created = (await (
      await api.post('/api/tables/bases', { data: { name: `${runId}-views` } })
    ).json()) as CreatedBase;
    const baseId = created.base.id;
    const tableId = created.schema.table.id;
    const primaryId = created.schema.fields[0]!.id;

    try {
      const stageResponse = await api.post(`/api/tables/tables/${tableId}/fields`, {
        data: {
          name: 'Stage',
          type: 'single_select',
          config: {
            options: [
              { id: 'lead', label: 'Lead' },
              { id: 'won', label: 'Won' },
            ],
          },
        },
      });
      expect(stageResponse.ok()).toBeTruthy();
      const stageId = ((await stageResponse.json()) as { field: { id: number } }).field.id;
      const recordResponse = await api.post(`/api/tables/tables/${tableId}/records`, {
        data: { values: { [primaryId]: `${runId}-deal`, [stageId]: 'lead' } },
      });
      expect(recordResponse.ok()).toBeTruthy();
      const recordId = ((await recordResponse.json()) as { record: { id: number } }).record.id;

      await page.goto(`/#/tables/${baseId}/table/${tableId}`);

      // New view → Kanban (the lanes default to the only single-select field).
      await page.getByRole('button', { name: 'New view' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await dialog.locator('input').first().fill(`${runId}-board`);
      await dialog.getByRole('button', { name: 'Kanban' }).click();
      await expect(dialog.locator('select').first()).toHaveValue(String(stageId));
      await dialog.getByRole('button', { name: 'Create view' }).click();
      await expect(dialog).toBeHidden();

      const card = page.getByTestId(`kanban-card-${recordId}`);
      const leadLane = page.getByTestId('kanban-lane-lead');
      const wonLane = page.getByTestId('kanban-lane-won');
      await expect(leadLane.getByTestId(`kanban-card-${recordId}`)).toBeVisible();

      // A real mouse drag: press, travel past the 5px threshold in steps, release over the lane.
      const from = (await card.boundingBox())!;
      const to = (await wonLane.boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 3 });
      await page.mouse.move(to.x + to.width / 2, to.y + 80, { steps: 12 });
      await page.mouse.up();

      await expect(wonLane.getByTestId(`kanban-card-${recordId}`)).toBeVisible();
      // The drop was a drag, not a click: no record drawer opened.
      await expect(page.getByRole('dialog')).toHaveCount(0);

      // Persisted on the server…
      await expect
        .poll(async () => {
          const response = await api.get(`/api/tables/tables/${tableId}/records/${recordId}`);
          const { record } = (await response.json()) as { record: { values: Record<string, unknown> } };
          return record.values[String(stageId)];
        })
        .toBe('won');

      // …and on a fresh load of the same view.
      await page.reload();
      const views = (await (await api.get(`/api/tables/tables/${tableId}/views`)).json()) as {
        views: Array<{ id: number; name: string; type: string }>;
      };
      const board = views.views.find((view) => view.name === `${runId}-board`);
      expect(board?.type).toBe('kanban');
      await page.getByRole('combobox', { name: 'View' }).selectOption(String(board!.id));
      await expect(page.getByTestId('kanban-lane-won').getByTestId(`kanban-card-${recordId}`)).toBeVisible();
    } finally {
      await api.post(`/api/tables/bases/${baseId}/archive`);
    }
  });
});
