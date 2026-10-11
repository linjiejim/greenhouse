/**
 * Submit-only Tables forms (spec 20261011-tables-foundation §3, acceptance 5).
 *
 * The test super builds a form in the forms dialog — audience "everyone",
 * one response per person — publishes it, and fills it in on `#/forms/:id`
 * with an attachment. A second, ordinary team member who is not in the Base
 * then submits through the API: once (with an uploaded file) and is refused
 * the second time, and still cannot read the table.
 */

import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';

interface CreatedBase {
  base: { id: number };
  schema: { table: { id: number }; fields: Array<{ id: number }> };
}

async function json<T>(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  expect(response.ok(), `${response.url()} → ${response.status()}`).toBeTruthy();
  return (await response.json()) as T;
}

test.describe('tables forms', () => {
  test('a form for everyone: built in the dialog, filled in the page, submitted by a non-member', async ({
    page,
    api,
    playwright,
    baseURL,
    runId,
  }) => {
    const created = await json<CreatedBase>(await api.post('/api/tables/bases', { data: { name: `${runId}-forms` } }));
    const baseId = created.base.id;
    const tableId = created.schema.table.id;
    const primaryId = created.schema.fields[0]!.id;
    const filesField = await json<{ field: { id: number } }>(
      await api.post(`/api/tables/tables/${tableId}/fields`, { data: { name: 'Receipt', type: 'attachment' } }),
    );
    const formName = `${runId}-intake`;
    const memberEmail = `${runId}-member@test.local`;
    const memberPassword = 'E2eFormsMember-1';
    let memberId: string | undefined;
    let memberFileId: number | undefined;

    try {
      // ── Build it in the forms dialog ──
      await page.goto(`/#/tables/${baseId}/table/${tableId}`);
      await page.getByRole('button', { name: 'Manage forms' }).click();
      await page.getByTestId('forms-new').click();
      const editor = page.getByTestId('form-editor');
      await expect(editor).toBeVisible();
      await page.getByTestId('form-name-input').fill(formName);
      await page.getByTestId('form-audience-select').selectOption('team');
      await editor.getByRole('switch', { name: 'Allow more than one response per person' }).click();
      await page.getByTestId('form-save').click();
      await expect(editor).toBeHidden();
      await expect(page.getByText(formName)).toBeVisible();

      const forms = await json<{ forms: Array<{ id: number; name: string; audience: { type: string } }> }>(
        await api.get(`/api/tables/tables/${tableId}/forms`),
      );
      const form = forms.forms.find((candidate) => candidate.name === formName)!;
      expect(form.audience).toEqual({ type: 'team' });
      const row = page.getByTestId(`form-row-${form.id}`);
      await expect(row).toContainText('Everyone');
      await row.getByRole('button', { name: 'Publish' }).click();
      await expect(row).toContainText('Published');

      // ── Fill it in on the submit page ──
      await page.goto(`/#/forms/${form.id}`);
      await expect(page.getByRole('heading', { name: formName })).toBeVisible();
      await page.getByLabel('Name').fill('Builder entry');
      await page.getByTestId('attachment-upload-input').setInputFiles({
        name: 'builder.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('builder receipt'),
      });
      await expect(page.getByText('builder.pdf', { exact: true })).toBeVisible();
      await page.getByTestId('form-submit').click();
      await expect(page.getByTestId('form-done')).toContainText('Response recorded');
      await expect(page.getByText('Submit another response')).toHaveCount(0);

      // ── A team member outside the Base submits through the API ──
      const createdUser = await json<{ user: { id: string } }>(
        await api.post('/api/admin/users', {
          data: { email: memberEmail, password: memberPassword, nickname: `${runId}-member` },
        }),
      );
      memberId = createdUser.user.id;
      const session = await json<{ accessToken: string }>(
        await api.post('/api/auth/login', { data: { email: memberEmail, password: memberPassword } }),
      );
      const member = await playwright.request.newContext({
        baseURL,
        extraHTTPHeaders: { Authorization: `Bearer ${session.accessToken}` },
      });
      try {
        const view = await json<{ form: { fields: Array<{ id: number }>; alreadySubmitted: boolean } }>(
          await member.get(`/api/forms/${form.id}`),
        );
        expect(view.form.alreadySubmitted).toBe(false);
        expect(view.form.fields.map((field) => field.id)).toEqual([primaryId, filesField.field.id]);

        const upload = await json<{ file: { id: number } }>(
          await member.post(`/api/forms/${form.id}/uploads`, {
            multipart: { file: { name: 'member.pdf', mimeType: 'application/pdf', buffer: Buffer.from('member') } },
          }),
        );
        memberFileId = upload.file.id;
        const submit = (label: string) =>
          member.post(`/api/forms/${form.id}/submit`, {
            data: { values: { [primaryId]: label, [filesField.field.id]: [upload.file.id] } },
          });
        const first = await submit('Member entry');
        expect(first.status()).toBe(201);
        expect(await first.json()).toEqual({ submitted: true, successMessage: 'Your response has been recorded.' });
        const second = await submit('Second try');
        expect(second.status()).toBe(409);

        // Submitting never made them a reader of the Base.
        expect((await member.get(`/api/tables/bases/${baseId}`)).status()).toBe(404);
        expect((await member.post(`/api/tables/tables/${tableId}/records/query`, { data: {} })).status()).toBe(404);
      } finally {
        await member.dispose();
      }

      // ── The builder sees both responses, each by its submitter ──
      const records = await json<{ records: Array<{ created_by: string; values: Record<string, unknown> }> }>(
        await api.post(`/api/tables/tables/${tableId}/records/query`, { data: {} }),
      );
      const byLabel = new Map(records.records.map((record) => [record.values[String(primaryId)], record]));
      expect([...byLabel.keys()].sort()).toEqual(['Builder entry', 'Member entry']);
      expect(byLabel.get('Member entry')!.created_by).toBe(memberId);
      expect(byLabel.get('Member entry')!.values[String(filesField.field.id)]).toEqual([memberFileId]);
    } finally {
      await api.post(`/api/tables/bases/${baseId}/archive`);
      if (memberId) await api.delete(`/api/admin/users/${memberId}`);
    }
  });
});
