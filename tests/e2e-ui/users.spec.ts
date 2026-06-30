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

      // Create
      await page.getByTestId('users-add').click();
      await page.getByTestId('user-email-input').fill(email);
      await page.getByTestId('user-password-input').fill('E2ePass-user-1');
      await page.getByTestId('user-nickname-input').fill(`${runId}-u1`);
      await page.getByTestId('user-create-submit').click();

      await expect(page.getByText(email)).toBeVisible();

      // Delete → confirm
      await page.getByTestId(`user-delete-${email}`).click();
      await expect(page.getByTestId('confirm-dialog')).toBeVisible();
      await page.getByTestId('confirm-dialog-confirm').click();

      // The regression assertion: success toast, NOT "Delete failed".
      await expect(page.getByText('User deleted')).toBeVisible();
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
