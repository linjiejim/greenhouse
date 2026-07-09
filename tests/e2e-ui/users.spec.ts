import { test, expect } from './fixtures';

test.describe('user management', () => {
  /**
   * Regression guard for the `users.delete` 500 bug (postgres-js has no `rowCount`,
   * so a successful delete used to return 500 → the UI showed a "Delete failed" error
   * toast even though the row was gone). A green run requires the SUCCESS toast.
   */
  test('creates a user, then deletes it with a success toast', async ({ page, api, runId }) => {
    const email = `${runId}-u1@test.local`;

    try {
      await page.goto('/#/settings/users');

      // Create (CrudForm testids: `{schema.testId}-add` / `-field-{key}` / `-submit`).
      await page.getByTestId('users-add').click();
      await page.getByTestId('users-field-email').fill(email);
      await page.getByTestId('users-field-password').fill('E2ePass-user-1');
      await page.getByTestId('users-field-nickname').fill(`${runId}-u1`);
      await page.getByTestId('users-submit').click();

      await expect(page.getByText(email)).toBeVisible();

      // Delete → confirm. Row action testids are shared across rows, so scope the
      // delete button to the row that shows this user's (unique, runId-tagged) email.
      const row = page.getByRole('row', { has: page.getByText(email) });
      await row.getByTestId('users-delete').click();
      await expect(page.getByTestId('confirm-dialog')).toBeVisible();
      await page.getByTestId('confirm-dialog-confirm').click();

      // The regression assertion: the delete-success toast (crud.deleted = "Deleted"),
      // NOT the "Failed to delete" error toast.
      await expect(page.getByText('Deleted', { exact: true })).toBeVisible();
      await expect(page.getByText(email)).toBeHidden();
    } finally {
      // Safety net: if anything above failed mid-way, remove the leftover user.
      const res = await api.get('/api/admin/users');
      const { users } = (await res.json()) as { users: Array<{ id: string; email: string }> };
      const leftover = users.find((u) => u.email === email);
      if (leftover) await api.delete(`/api/admin/users/${leftover.id}`);
    }
  });
});
