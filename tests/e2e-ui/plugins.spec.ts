import { test, expect } from './fixtures';

test('Administration plugin inventory is read-only and matches the API', async ({ page, api }) => {
  const response = await api.get('/api/admin/plugins');
  expect(response.ok()).toBe(true);
  const { plugins } = await response.json();
  expect(plugins).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'example',
        compiled: true,
        enabled: true,
        sdk: 1,
        migrationState: 'applied',
        bootState: 'ready',
      }),
    ]),
  );
  await page.goto('/#/administration/plugins');
  const inventory = page.getByTestId('admin-plugins');
  await expect(inventory).toContainText('Example notes');
  await expect(inventory).toContainText('Applied');
  await expect(
    page.getByText(
      'To enable or disable a plugin, change greenhouse.config.ts or GREENHOUSE_EXTENSIONS and restart the server.',
    ),
  ).toBeVisible();
  await expect(inventory.getByRole('switch')).toHaveCount(0);
  await expect(page.getByTestId('admin-plugins-add')).toHaveCount(0);
  await expect(page.getByTestId('admin-plugins-delete')).toHaveCount(0);
});
