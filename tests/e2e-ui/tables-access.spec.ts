/**
 * Tables sharing in the browser (Phase 0 slice A): the owner builds a custom
 * role in the share dialog — a readable table with one hidden field, whose
 * dependent formula the editor marks hidden too — saves it, and grants it to a
 * person. The server's own state is checked through the API afterwards.
 */

import { test, expect } from './fixtures';

interface Field {
  id: number;
}

test.describe('tables access', () => {
  test('builds a custom role with a hidden field and grants it to a person', async ({ page, api, runId }) => {
    const created = await api.post('/api/tables/bases', {
      data: { name: `${runId}-crm`, defaultTableName: 'Customers' },
    });
    expect(created.ok()).toBeTruthy();
    const { base, schema } = (await created.json()) as {
      base: { id: number };
      schema: { table: { id: number } };
    };
    const tableId = schema.table.id;
    const field = async (data: unknown) => {
      const response = await api.post(`/api/tables/tables/${tableId}/fields`, { data });
      expect(response.ok()).toBeTruthy();
      return ((await response.json()) as { field: Field }).field;
    };
    const amount = await field({ name: 'Amount', type: 'number' });
    await field({
      name: 'Commission',
      type: 'formula',
      config: {
        formula: {
          resultType: 'number',
          expression: {
            type: 'binary',
            operator: 'multiply',
            left: { type: 'field', fieldId: amount.id },
            right: { type: 'literal', value: 0.1 },
          },
        },
      },
    });
    const roleName = `${runId}-sales`;
    // CI starts from an empty DB, so the grantee is created here rather than
    // picked from whoever happens to exist.
    const mateName = `Grantee${runId.replace(/[^a-z0-9]/gi, '').slice(-6)}`;
    const mate = await api.post('/api/admin/users', {
      data: { email: `${runId}-grantee@test.local`, password: 'E2eAccessGrantee-1', nickname: mateName },
    });
    expect(mate.ok()).toBeTruthy();
    const mateId = ((await mate.json()) as { user: { id: string } }).user.id;

    try {
      await page.goto(`/#/tables/${base.id}/table/${tableId}`);
      await page.getByRole('button', { name: 'Share' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByTestId('share-tab-members')).toBeVisible();

      // Roles: a new role reads Customers, every field but Amount.
      await dialog.getByTestId('share-tab-roles').click();
      await dialog.getByRole('button', { name: 'New role' }).click();
      await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(roleName);
      const customers = dialog.getByTestId(`role-table-${tableId}`);
      await customers.getByRole('button', { name: 'Can read' }).click();
      await customers.getByRole('switch', { name: 'Show all fields' }).click();
      await customers.getByLabel('Access to Amount').selectOption('hidden');
      await expect(customers.getByText('Hidden because it depends on a hidden field')).toBeVisible();
      await dialog.getByRole('button', { name: 'Save role' }).click();
      await expect(dialog.getByRole('button', { name: new RegExp(roleName) })).toBeVisible();

      const roles = (await (await api.get(`/api/tables/bases/${base.id}/roles`)).json()) as {
        roles: Array<{ id: number; name: string; rules: { tables: Array<Record<string, unknown>> } }>;
      };
      const role = roles.roles.find((entry) => entry.name === roleName);
      expect(role?.rules.tables).toEqual([
        {
          tableId,
          access: 'read',
          fields: [{ fieldId: amount.id, access: 'hidden' }],
          fieldDefault: 'visible',
        },
      ]);

      // Members: grant the role to a person through the shared picker.
      await dialog.getByTestId('share-tab-members').click();
      const picker = dialog.getByTestId('principal-picker');
      await picker.getByRole('textbox', { name: 'Search people' }).fill(mateName);
      await picker.getByRole('checkbox', { name: new RegExp(mateName) }).check();
      await dialog.getByLabel('Role', { exact: true }).selectOption({ label: `Custom: ${roleName}` });
      await dialog.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(dialog.getByLabel(/^Role of /).first()).toHaveValue(`custom:${role!.id}`);

      const grants = (await (await api.get(`/api/tables/bases/${base.id}/members`)).json()) as {
        members: Array<{ role: string; custom_role_id: number | null }>;
      };
      expect(grants.members).toContainEqual(expect.objectContaining({ role: 'custom', custom_role_id: role!.id }));
    } finally {
      await api.post(`/api/tables/bases/${base.id}/archive`);
      await api.delete(`/api/admin/users/${mateId}`);
    }
  });
});
