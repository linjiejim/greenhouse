/**
 * An app in use (spec 20261011-tables-apps §6, acceptance 1–2 and 7 from the
 * user's side). The test super owns a Base and publishes a small "purchase
 * requests" app to everyone as the "applicant" role — own rows only, the
 * approval note hidden. An ordinary team member who is not in the Base then:
 * finds it under "Shared with me" and pins it to the sidebar, opens it, does
 * not see the owner's row, submits the form, sees their own request (never
 * the hidden column, not in the list nor in the record), and still cannot
 * read the table through `/api/tables`.
 *
 * Seeding is over the API; everything the member does is in the browser.
 * Needs the app gateway (slice G) — the runtime reads only through it.
 */

import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';

async function json<T>(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  expect(response.ok(), `${response.url()} → ${response.status()}`).toBeTruthy();
  return (await response.json()) as T;
}

async function login(page: Page, email: string, password: string) {
  await page.goto('/');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 20_000 });
}

interface CreatedBase {
  base: { id: number };
  schema: { table: { id: number }; fields: Array<{ id: number }> };
}

test.describe('apps runtime', () => {
  test('a shared app: own rows only, a form submit, no hidden column, pinned to the sidebar', async ({
    api,
    browser,
    playwright,
    baseURL,
    runId,
  }) => {
    // ── The owner's Base: requests with an amount, a status and an internal note ──
    const created = await json<CreatedBase>(
      await api.post('/api/tables/bases', { data: { name: `${runId}-purchasing`, defaultTableName: 'Requests' } }),
    );
    const baseId = created.base.id;
    const tableId = created.schema.table.id;
    const nameId = created.schema.fields[0]!.id;
    const field = async (data: unknown) =>
      (await json<{ field: { id: number } }>(await api.post(`/api/tables/tables/${tableId}/fields`, { data }))).field
        .id;
    const amountId = await field({ name: 'Amount', type: 'number' });
    const statusId = await field({
      name: 'Status',
      type: 'single_select',
      config: {
        options: [
          { id: 'pending', label: 'Pending' },
          { id: 'approved', label: 'Approved' },
        ],
      },
    });
    const noteId = await field({ name: 'Approval note', type: 'long_text' });
    const ownerRow = `${runId} owner request`;
    await json(
      await api.post(`/api/tables/tables/${tableId}/records`, {
        data: { values: { [nameId]: ownerRow, [amountId]: 999, [statusId]: 'pending', [noteId]: 'internal remark' } },
      }),
    );

    // ── The app: one page (my requests + a request form), one role, shared with everyone ──
    const appName = `${runId} purchase requests`;
    const spec = {
      version: 1,
      home: 'mine',
      pages: [
        {
          id: 'mine',
          title: 'My requests',
          cards: [
            {
              id: 'list',
              title: 'My requests',
              kind: 'records',
              layout: { x: 0, y: 0, w: 7, h: 6 },
              source: { tableId },
              fieldIds: [nameId, amountId, statusId],
              detail: { fieldIds: [nameId, amountId, statusId] },
            },
            {
              id: 'apply',
              title: 'New request',
              kind: 'form',
              layout: { x: 7, y: 0, w: 5, h: 6 },
              tableId,
              fieldIds: [nameId, amountId],
              defaults: [{ fieldId: statusId, value: 'pending' }],
              submitLabel: 'Send request',
            },
          ],
        },
      ],
      roles: [
        {
          key: 'applicant',
          name: 'Applicant',
          pages: 'all',
          tables: [
            {
              tableId,
              access: 'edit',
              rows: { type: 'related', creator: true, fieldIds: [] },
              fields: [
                { fieldId: nameId, access: 'edit' },
                { fieldId: amountId, access: 'edit' },
                { fieldId: statusId, access: 'read' },
                { fieldId: noteId, access: 'hidden' },
              ],
              fieldDefault: 'hidden',
              create: true,
            },
          ],
        },
      ],
    };
    const draft = await json<{ app: { id: number }; draftRevision: number; errors: unknown[] }>(
      await api.post('/api/apps', { data: { baseId, name: appName, icon: 'cart', accent: 'amber', spec } }),
    );
    expect(draft.errors).toEqual([]);
    const appId = draft.app.id;
    await json(
      await api.post(`/api/apps/${appId}/publish`, { data: { draftRevision: draft.draftRevision, notes: 'v1' } }),
    );
    const audiences = await json<{ audiencesRevision: number }>(await api.get(`/api/apps/${appId}/audiences`));
    await json(
      await api.put(`/api/apps/${appId}/audiences`, {
        data: {
          entries: [{ principal: { type: 'team' }, roleKey: 'applicant' }],
          audiencesRevision: audiences.audiencesRevision,
        },
      }),
    );

    // ── A team member outside the Base ──
    const memberEmail = `${runId}-applicant@test.local`;
    const memberPassword = 'E2eAppsApplicant-1';
    const memberId = (
      await json<{ user: { id: string } }>(
        await api.post('/api/admin/users', {
          data: { email: memberEmail, password: memberPassword, nickname: `${runId}-applicant` },
        }),
      )
    ).user.id;
    const memberContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });

    try {
      const page = await memberContext.newPage();
      await login(page, memberEmail, memberPassword);

      // ── The app center: shared with them; pinning puts it in the sidebar ──
      await page.goto('/#/apps');
      const shared = page.getByTestId('app-shelf-shared');
      await expect(shared).toContainText(appName);
      await shared.getByRole('button', { name: `Pin ${appName} to the sidebar` }).click();
      await expect(page.getByTestId(`sidebar-app-${appId}`)).toBeVisible();

      // ── The app: nobody else's request is listed ──
      await page.getByTestId(`sidebar-app-${appId}`).click();
      const runtime = page.getByTestId('app-runtime');
      await expect(runtime.getByRole('heading', { name: appName })).toBeVisible();
      await expect(runtime).toContainText('Applicant');
      const list = page.getByTestId('app-card-list');
      await expect(list).toContainText('Nothing here yet');
      await expect(page.getByText(ownerRow)).toHaveCount(0);

      // ── Submit a request through the form card ──
      const form = page.getByTestId('app-form-apply');
      await form.getByLabel('Name').fill('Laptop');
      await form.getByLabel('Amount').fill('1200');
      await page.getByTestId('app-form-apply-submit').click();
      await expect(page.getByTestId('app-form-apply-done')).toBeVisible();

      // ── Their request appears; the owner's never does; the hidden column is nowhere ──
      await expect(list).toContainText('Laptop');
      await expect(list).toContainText('1,200');
      await expect(page.getByText(ownerRow)).toHaveCount(0);
      await expect(page.getByText('Approval note')).toHaveCount(0);
      await list.getByRole('button', { name: 'Open Laptop' }).click();
      const drawer = page.getByTestId('app-record-drawer');
      await expect(drawer).toContainText('Laptop');
      await expect(drawer).toContainText('Pending');
      await expect(drawer).not.toContainText('Approval note');

      // ── The app is their only way in: the Tables API knows nothing for them ──
      const token = await page.evaluate(() => localStorage.getItem('greenhouse_access_token'));
      const member = await playwright.request.newContext({
        baseURL,
        extraHTTPHeaders: { Authorization: `Bearer ${token}` },
      });
      try {
        expect((await member.get(`/api/tables/bases/${baseId}`)).status()).toBe(404);
        expect((await member.post(`/api/tables/tables/${tableId}/records/query`, { data: {} })).status()).toBe(404);
      } finally {
        await member.dispose();
      }

      // ── The owner sees the request, written by the member, with the form's default status ──
      const records = await json<{ records: Array<{ created_by: string; values: Record<string, unknown> }> }>(
        await api.post(`/api/tables/tables/${tableId}/records/query`, { data: {} }),
      );
      const laptop = records.records.find((record) => record.values[String(nameId)] === 'Laptop');
      expect(laptop?.created_by).toBe(memberId);
      expect(laptop?.values[String(statusId)]).toBe('pending');
      expect(laptop?.values[String(amountId)]).toBe(1200);
    } finally {
      await memberContext.close();
      await api.post(`/api/apps/${appId}/archive`);
      await api.post(`/api/tables/bases/${baseId}/archive`);
      await api.delete(`/api/admin/users/${memberId}`);
    }
  });
});
