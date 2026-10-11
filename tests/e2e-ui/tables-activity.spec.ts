/**
 * Record comments and history (spec 20261011-tables-foundation §7, acceptance 9).
 *
 * A teammate (Base editor) changes a record; the test super opens it, reads
 * the change in the Activity tab, and comments with an @mention picked from the
 * list. The teammate gets a `tables_mention` in their inbox, and opening it lands
 * on that record's drawer.
 */

import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, TEST_ACCOUNT } from './fixtures';

interface CreatedBase {
  base: { id: number };
  schema: { table: { id: number }; fields: Array<{ id: number }> };
}

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

test.describe('tables activity', () => {
  test('a change shows in the Activity tab; an @mention reaches the teammate and opens the record', async ({
    page,
    api,
    browser,
    playwright,
    baseURL,
    runId,
  }) => {
    // Two people signed in and a full round trip through the inbox.
    test.setTimeout(90_000);
    const created = await json<CreatedBase>(
      await api.post('/api/tables/bases', { data: { name: `${runId}-activity` } }),
    );
    const baseId = created.base.id;
    const tableId = created.schema.table.id;
    const primaryId = created.schema.fields[0]!.id;
    const mateEmail = `${runId}-mate@test.local`;
    const matePassword = 'E2eActivityMate-1';
    const mateName = `Mate${runId.replace(/[^a-z0-9]/gi, '').slice(-6)}`;
    let mateId: string | undefined;

    try {
      const record = await json<{ record: { id: number; revision: number } }>(
        await api.post(`/api/tables/tables/${tableId}/records`, { data: { values: { [primaryId]: 'Acme' } } }),
      );
      const recordId = record.record.id;

      // ── A teammate who edits the Base signs in once and changes the record ──
      mateId = (
        await json<{ user: { id: string } }>(
          await api.post('/api/admin/users', {
            data: { email: mateEmail, password: matePassword, nickname: mateName },
          }),
        )
      ).user.id;
      await json(await api.put(`/api/tables/bases/${baseId}/members/${mateId}`, { data: { role: 'editor' } }));
      // One sign-in for the teammate (login is rate limited per address): the
      // browser session also carries their API calls.
      const mateContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      try {
        const matePage = await mateContext.newPage();
        await login(matePage, mateEmail, matePassword);
        const mateToken = await matePage.evaluate(() => localStorage.getItem('greenhouse_access_token'));
        const mate = await playwright.request.newContext({
          baseURL,
          extraHTTPHeaders: { Authorization: `Bearer ${mateToken}` },
        });
        try {
          await json(
            await mate.patch(`/api/tables/tables/${tableId}/records/${recordId}`, {
              data: { revision: record.record.revision, values: { [primaryId]: 'Acme Ltd' } },
            }),
          );
        } finally {
          await mate.dispose();
        }

        // ── The super reads the change and comments with a mention ──
        await page.goto(`/#/tables/${baseId}/table/${tableId}?record=${recordId}`);
        await expect(page.getByText(`Record #${recordId}`, { exact: true })).toBeVisible();
        await page.getByRole('tab', { name: 'Activity' }).click();
        const timeline = page.getByRole('list', { name: 'Record activity' });
        await expect(timeline).toContainText(`${mateName} changed this record`);
        await expect(timeline).toContainText('Acme Ltd');
        await expect(timeline).toContainText(`${TEST_ACCOUNT.nickname} created this record`);
        await expect(timeline.getByText('Person').first()).toBeVisible();

        const composer = page.getByRole('textbox', { name: 'Comment' });
        await composer.click();
        await composer.pressSequentially(`@${mateName.slice(0, 4)}`);
        await page.getByRole('option', { name: new RegExp(mateName) }).click();
        await expect(composer).toHaveValue(`@${mateName} `);
        await composer.pressSequentially('please confirm the new name');
        await page.getByRole('button', { name: 'Comment', exact: true }).click();
        await expect(composer).toHaveValue('');
        const posted = timeline.getByRole('listitem').first();
        await expect(posted).toContainText('please confirm the new name');
        await expect(posted.locator('a.kb-mention')).toHaveText(`@${mateName}`);

        // ── The teammate's inbox has the mention; opening it lands on the record ──
        // The account menu opens on hover (a click on the trigger goes to Settings).
        await matePage.getByTitle(mateName).first().hover();
        await matePage.getByRole('menuitem', { name: /Inbox/ }).click();
        const notice = matePage.getByRole('button', { name: new RegExp(`${TEST_ACCOUNT.nickname} mentioned you`) });
        await expect(notice).toBeVisible();
        await notice.click();
        await expect(matePage).toHaveURL(new RegExp(`#/tables/${baseId}/table/${tableId}\\?record=${recordId}`));
        await expect(matePage.getByText(`Record #${recordId}`, { exact: true })).toBeVisible();
      } finally {
        await mateContext.close();
      }
    } finally {
      await api.post(`/api/tables/bases/${baseId}/archive`);
      if (mateId) await api.delete(`/api/admin/users/${mateId}`);
    }
  });
});
