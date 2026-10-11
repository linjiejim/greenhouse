/**
 * Background automations (spec 20261011-tables-foundation §4, acceptance 6).
 *
 * The test super builds a rule in the rule editor — when a record starts
 * matching "Status is Done", notify the person in its Owner field (inbox) with
 * a title that names the record — saves it disabled, enables it from the list,
 * then moves a record to Done in the grid. The worker runs the rule: the owner
 * (a second member who may read the Base) gets a `tables_automation`
 * notification with the rendered title, and the run log shows the step.
 */

import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';

interface CreatedBase {
  base: { id: number };
  schema: { table: { id: number }; fields: Array<{ id: number }> };
}

interface Automation {
  id: number;
  name: string;
  status: string;
  trigger: string;
  config: { condition?: unknown; actions: Array<{ type: string; recipients?: { userFieldIds?: number[] } }> };
}

async function json<T>(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  expect(response.ok(), `${response.url()} → ${response.status()}`).toBeTruthy();
  return (await response.json()) as T;
}

test.describe('tables automations', () => {
  test('a rule built in the editor notifies the record owner when the status turns Done', async ({
    page,
    api,
    playwright,
    baseURL,
    runId,
  }) => {
    // The worker polls every 2 s; the run, the inbox and the run log are a few round trips.
    test.setTimeout(90_000);
    const created = await json<CreatedBase>(await api.post('/api/tables/bases', { data: { name: `${runId}-rules` } }));
    const baseId = created.base.id;
    const tableId = created.schema.table.id;
    const primaryId = created.schema.fields[0]!.id;
    const ruleName = `${runId}-done`;
    const taskName = `${runId}-task`;
    const ownerEmail = `${runId}-owner@test.local`;
    const ownerPassword = 'E2eAutomationOwner-1';
    let ownerId: string | undefined;

    try {
      const field = async (name: string, type: string, config?: unknown) =>
        (
          await json<{ field: { id: number } }>(
            await api.post(`/api/tables/tables/${tableId}/fields`, { data: { name, type, config } }),
          )
        ).field.id;
      const statusId = await field('Status', 'single_select', {
        options: [
          { id: 'todo', label: 'To do' },
          { id: 'done', label: 'Done' },
        ],
      });
      const ownerFieldId = await field('Owner', 'user');

      // The person to notify: a second member who may read the Base (unreadable records skip their recipient).
      ownerId = (
        await json<{ user: { id: string } }>(
          await api.post('/api/admin/users', {
            data: { email: ownerEmail, password: ownerPassword, nickname: `${runId}-owner` },
          }),
        )
      ).user.id;
      await json(await api.put(`/api/tables/bases/${baseId}/members/${ownerId}`, { data: { role: 'viewer' } }));
      const record = await json<{ record: { id: number } }>(
        await api.post(`/api/tables/tables/${tableId}/records`, {
          data: { values: { [primaryId]: taskName, [statusId]: 'todo', [ownerFieldId]: ownerId } },
        }),
      );
      const recordId = record.record.id;

      // ── Build the rule in the editor ──
      await page.goto(`/#/tables/${baseId}/table/${tableId}`);
      await page.getByRole('button', { name: 'Automations', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await page.getByTestId('automation-new').click();
      const editor = page.getByTestId('automation-rule-editor');
      await expect(editor).toBeVisible();
      await editor.getByRole('textbox', { name: 'Name', exact: true }).fill(ruleName);
      await editor.getByTestId('automation-trigger').selectOption('record_matched');

      await editor.getByRole('button', { name: 'Condition', exact: true }).click();
      await editor.getByLabel('Choose field').selectOption(`f:${statusId}`);
      await expect(editor.getByLabel('Operator')).toHaveValue('eq');
      await editor.getByLabel('Value', { exact: true }).selectOption('done');

      // A new rule starts with one "Notify people" step.
      const notify = editor.getByTestId('automation-action-0');
      await expect(notify).toContainText('Notify people');
      await notify.getByRole('checkbox', { name: 'Owner', exact: true }).check();
      await notify.getByLabel('Title', { exact: true }).fill(`Done: {{field:${primaryId}}}`);
      await notify.getByLabel('Message', { exact: true }).fill('Marked done in the grid');

      // Saved disabled, enabled from the list.
      await editor.getByRole('switch', { name: 'Enabled' }).click();
      await page.getByTestId('automation-save').click();
      await expect(editor).toBeHidden();
      const row = dialog.getByRole('listitem').filter({ hasText: ruleName });
      await expect(row).toContainText('Disabled');
      await expect(row).toContainText('A record starts matching a condition');
      await row.getByRole('switch', { name: 'Enabled' }).click();
      await expect(row).toContainText('Enabled');

      const rules = await json<{ automations: Automation[] }>(await api.get(`/api/tables/bases/${baseId}/automations`));
      const rule = rules.automations.find((candidate) => candidate.name === ruleName)!;
      expect(rule).toMatchObject({ status: 'enabled', trigger: 'record_matched' });
      expect(rule.config.condition).toEqual({
        combinator: 'and',
        clauses: [{ fieldId: statusId, operator: 'eq', value: 'done' }],
      });
      expect(rule.config.actions).toHaveLength(1);
      expect(rule.config.actions[0]).toMatchObject({ type: 'notify', recipients: { userFieldIds: [ownerFieldId] } });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();

      // ── Move the record to Done in the grid ──
      const cell = page.getByRole('button', { name: 'Edit Status' });
      await cell.hover();
      await cell.click();
      await page.getByRole('combobox', { name: 'Status' }).selectOption('done');
      await expect(page.getByRole('combobox', { name: 'Status' })).toHaveCount(0);
      await expect
        .poll(async () => {
          const current = await json<{ record: { values: Record<string, unknown> } }>(
            await api.get(`/api/tables/tables/${tableId}/records/${recordId}`),
          );
          return current.record.values[String(statusId)];
        })
        .toBe('done');

      // ── The owner's inbox gets the rendered title ──
      const session = await json<{ accessToken: string }>(
        await api.post('/api/auth/login', { data: { email: ownerEmail, password: ownerPassword } }),
      );
      const owner = await playwright.request.newContext({
        baseURL,
        extraHTTPHeaders: { Authorization: `Bearer ${session.accessToken}` },
      });
      try {
        await expect
          .poll(
            async () => {
              const inbox = await json<{ notifications: Array<{ kind: string; title: string; body: string }> }>(
                await owner.get('/api/notifications?limit=20'),
              );
              const notice = inbox.notifications.find((entry) => entry.kind === 'tables_automation');
              return notice ? { title: notice.title, body: notice.body } : null;
            },
            { timeout: 30_000 },
          )
          .toEqual({ title: `Done: ${taskName}`, body: 'Marked done in the grid' });
      } finally {
        await owner.dispose();
      }

      // ── The run log shows the step ──
      await expect
        .poll(
          async () =>
            (
              await json<{ runs: Array<{ status: string }> }>(await api.get(`/api/tables/automations/${rule.id}/runs`))
            ).runs.map((run) => run.status),
          { timeout: 15_000 },
        )
        .toEqual(['succeeded']);
      await page.getByRole('button', { name: 'Automations', exact: true }).click();
      await dialog.getByRole('listitem').filter({ hasText: ruleName }).getByRole('button', { name: 'Run log' }).click();
      const log = page.getByTestId('automation-run-log');
      await expect(log).toContainText(`Run log · ${ruleName}`);
      await expect(log).toContainText('Succeeded');
      await expect(log).toContainText('A record starts matching a condition');
      await expect(log).toContainText(`Record #${recordId}`);
      await expect(log).toContainText('Notified 1 · skipped 0 who cannot open the record');
    } finally {
      await api.post(`/api/tables/bases/${baseId}/archive`);
      if (ownerId) await api.delete(`/api/admin/users/${ownerId}`);
    }
  });
});
