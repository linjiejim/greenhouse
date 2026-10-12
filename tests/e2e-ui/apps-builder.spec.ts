/**
 * The app builder (spec 20261011-tables-apps §6; acceptance 1 and 4 from the
 * builder's side). The test super — the Base owner — creates an app from the
 * Base's Apps section and builds two pages: "Apply" with a records card and a
 * form card, "Approve" with a records card whose row button "Approve" sets the
 * status. It gives the role edit access, publishes v1, edits a card, sees the
 * change in the publish dialog and publishes v2, then restores v1 into the
 * draft — v2 stays live and the draft is v1's again.
 *
 * Every step goes through the real `/api/apps` routes and the server's spec
 * validator (a draft with problems cannot be published).
 */

import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';

interface CreatedBase {
  base: { id: number };
  schema: { table: { id: number }; fields: Array<{ id: number; name: string }> };
}

async function json<T>(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  expect(response.ok(), `${response.url()} → ${response.status()}: ${await response.text()}`).toBeTruthy();
  return (await response.json()) as T;
}

/** Wait until the draft is saved (autosave is debounced) with no problems left. */
async function saved(page: Page) {
  await expect(page.getByTestId('app-save-state')).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
}

async function addCard(page: Page, kind: string) {
  await page.getByTestId('app-add-card').click();
  await page.getByTestId(`app-catalog-${kind}`).click();
  await expect(page.getByTestId('app-card-catalog')).toBeHidden();
}

async function renamePage(page: Page, title: string) {
  await page.getByTestId('app-page-settings').click();
  const input = page.getByTestId('app-page-title');
  await input.fill(title);
  await saved(page);
}

test.describe('apps builder', () => {
  test('builds a two-page app, publishes v1 and v2, restores v1 into the draft', async ({ page, api, runId }) => {
    test.setTimeout(120_000);
    const created = await json<CreatedBase>(
      await api.post('/api/tables/bases', { data: { name: `${runId}-procurement` } }),
    );
    const baseId = created.base.id;
    const tableId = created.schema.table.id;
    await json(await api.patch(`/api/tables/tables/${tableId}`, { data: { name: 'Requests' } }));
    const statusField = await json<{ field: { id: number } }>(
      await api.post(`/api/tables/tables/${tableId}/fields`, {
        data: {
          name: 'Status',
          type: 'single_select',
          config: {
            options: [
              { id: 'pending', label: 'Pending' },
              { id: 'approved', label: 'Approved' },
            ],
          },
        },
      }),
    );
    await json(await api.post(`/api/tables/tables/${tableId}/fields`, { data: { name: 'Amount', type: 'number' } }));
    let appId: number | undefined;

    try {
      // ── Create the app from the Base's Apps section ──
      await page.goto(`/#/tables/${baseId}/table/${tableId}`);
      await page.getByTestId('base-apps-button').click();
      await page.getByTestId('base-apps-new').click();
      await page.getByTestId('app-create-name').fill(`${runId} purchases`);
      await page.getByTestId('app-create-submit').click();
      await expect(page).toHaveURL(/#\/apps\/\d+\/edit$/);
      appId = Number(/#\/apps\/(\d+)\/edit/.exec(page.url())![1]);
      await expect(page.getByTestId('app-builder-status')).toHaveText('Not published yet');

      // ── Page 1 "Apply": a records card and a form card ──
      await renamePage(page, 'Apply');
      await addCard(page, 'records');
      await addCard(page, 'form');
      await saved(page);

      // ── Page 2 "Approve": a records card with an "Approve" row button ──
      await page.getByTestId('app-add-page').click();
      await expect(page.getByTestId('app-page-new-page')).toBeVisible();
      await renamePage(page, 'Approve');
      await addCard(page, 'records');
      await page.locator('summary').filter({ hasText: 'Buttons on each record' }).click();
      const rowActions = page.getByTestId('app-row-actions');
      await rowActions.getByRole('button', { name: 'Add a button' }).click();
      const action = rowActions.getByTestId('app-action-action-1');
      await action.getByLabel('Label').fill('Approve');
      // Write the status instead of asking for a field.
      await action.getByRole('button', { name: 'Add a value' }).click();
      await action.getByRole('combobox', { name: 'Field', exact: true }).selectOption(String(statusField.field.id));
      await action.locator('select:has(option:has-text("Approved"))').last().selectOption('approved');
      await action.getByRole('checkbox', { name: 'Name', exact: true }).uncheck();
      await saved(page);
      // The member role cannot edit Requests yet: the builder says so, and the server agrees.
      await expect(page.getByTestId('app-action-blocked-action-1')).toContainText('Member');
      await expect(page.getByTestId('app-problems-button')).toBeVisible();

      // ── Roles: the member may edit Requests and see every field ──
      await page.getByTestId('app-tab-roles').click();
      const rule = page.getByTestId(`role-table-${tableId}`);
      await rule.getByRole('button', { name: 'Can edit' }).click();
      await rule.getByRole('switch', { name: 'Show all fields' }).click();
      await saved(page);
      await expect(page.getByTestId('app-problems-button')).toBeHidden();

      // ── Publish v1 ──
      await page.getByTestId('app-publish').click();
      const dialog = page.getByTestId('app-publish-dialog');
      await expect(dialog).toContainText('The first version goes live — pages: 2, cards: 5, roles: 1.');
      await expect(page.getByTestId('app-publish-permissions')).toContainText('Can edit');
      await page.getByTestId('app-publish-notes').fill('First version');
      await page.getByTestId('app-publish-confirm').click();
      await expect(page.getByTestId('app-builder-status')).toHaveText('v1 is live');

      // ── Edit: rename the approval queue, publish v2 ──
      await page.getByTestId('app-tab-pages').click();
      await page.getByTestId('app-page-new-page').click();
      await page
        .getByTestId('app-canvas-card-records-1')
        .getByRole('button', { name: /^Set up/ })
        .click();
      await page.getByTestId('app-card-title').fill('Approval queue');
      await saved(page);
      await page.getByTestId('app-publish').click();
      await expect(dialog).toContainText('Page “Approve”: cards changed: 1');
      await expect(dialog).toContainText('No permission changes.');
      await page.getByTestId('app-publish-confirm').click();
      await expect(page.getByTestId('app-builder-status')).toHaveText('v2 is live');

      // ── Restore v1 into the draft: v2 stays live ──
      await page.getByTestId('app-versions-button').click();
      const versions = page.getByTestId('app-versions');
      await expect(versions.getByTestId('app-version-2')).toContainText('Live');
      await expect(versions.getByTestId('app-version-1')).toContainText('First version');
      await versions.getByTestId('app-version-restore-1').click();
      await page.getByRole('button', { name: 'Restore to draft' }).last().click();
      await expect(versions).toBeHidden();
      await expect(page.getByTestId('app-canvas-card-records-1')).toContainText('Requests');
      await expect(page.getByTestId('app-canvas-card-records-1')).not.toContainText('Approval queue');
      await expect(page.getByTestId('app-builder-status')).toHaveText('v2 is live');

      // The server agrees: two versions, the draft is v1's spec again.
      const list = await json<{ versions: Array<{ version: number; notes: string | null }> }>(
        await api.get(`/api/apps/${appId}/versions`),
      );
      expect(list.versions.map((version) => version.version)).toEqual([2, 1]);
      const draft = await json<{
        spec: { pages: Array<{ id: string; cards: Array<{ id: string; title?: string }> }> };
      }>(await api.get(`/api/apps/${appId}/draft`));
      expect(draft.spec.pages.map((entry) => entry.id)).toEqual(['home', 'new-page']);
      expect(draft.spec.pages[1]!.cards.find((card) => card.id === 'records-1')?.title).toBe('Requests');
    } finally {
      if (appId) await api.post(`/api/apps/${appId}/archive`);
      await api.post(`/api/tables/bases/${baseId}/archive`);
    }
  });
});
