import { expect, test } from '@playwright/test';
import { apiAs } from './api';
import { open } from './fixtures';

/** What this test reads of a new base from the API. */
interface NewBase {
  id: string;
  tables: Array<{ id: string; name: string }>;
}

test('tables: a CSV import creates the rows it can read and names the ones it skips', async ({ page, request }) => {
  // A blank base with a number and a date field next to its 名称.
  const base = await apiAs<NewBase>(request, 'lin', 'POST', '/api/tables/bases', { name: 'E2E 导入' });
  const table = base.tables[0]!;
  await apiAs(request, 'lin', 'POST', `/api/tables/tables/${table.id}/fields`, { name: '数量', type: 'number' });
  await apiAs(request, 'lin', 'POST', `/api/tables/tables/${table.id}/fields`, { name: '截止', type: 'date' });

  await open(page, `/#/tables/${base.id}`);
  await page.getByRole('main').getByRole('button', { name: '更多' }).first().click();
  await page.getByRole('menuitem', { name: '导入 CSV' }).click();
  const drawer = page.getByRole('dialog', { name: `导入到「${table.name}」` });
  // Saved by Excel as CSV UTF-8: a byte order mark and CRLF. Row 3 has a bad number, row 4 a bad date.
  const csv = ['名称,数量,截止', '苹果,3,2026-10-20', '香蕉,很多,2026-10-21', '橙子,5,2026-13-40', '梨,7,2026-10-22'];
  await drawer.locator('input[type="file"]').setInputFiles({
    name: 'fruit.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`\uFEFF${csv.join('\r\n')}\r\n`),
  });

  // Each column goes into the field of the same name.
  await expect(drawer.getByText('共 4 条', { exact: true })).toBeVisible();
  await expect(drawer.getByRole('combobox', { name: '「名称」导入到' })).toHaveText('名称');
  await expect(drawer.getByRole('combobox', { name: '「数量」导入到' })).toHaveText('数量');
  await expect(drawer.getByRole('combobox', { name: '「截止」导入到' })).toHaveText('截止');
  await drawer.getByRole('button', { name: '开始导入' }).click();

  // The background job writes it; the drawer follows until it is done.
  await expect(drawer.getByText('已完成', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(drawer.getByText('已导入 2 条', { exact: true })).toBeVisible();
  await expect(drawer.getByText('跳过 2 条', { exact: true })).toBeVisible();
  const skipped = drawer.getByRole('list', { name: '没有导入的行' }).getByRole('listitem');
  await expect(skipped).toHaveCount(2);
  await expect(skipped.nth(0)).toContainText('第 3 行');
  await expect(skipped.nth(0)).toContainText('数量');
  await expect(skipped.nth(0)).toContainText('「很多」不是数字');
  await expect(skipped.nth(1)).toContainText('第 4 行');
  await expect(skipped.nth(1)).toContainText('截止');
  await expect(skipped.nth(1)).toContainText('「2026-13-40」不是日期');
  await drawer.getByRole('button', { name: '完成', exact: true }).click();
  await expect(drawer).toBeHidden();

  // The rows it could read are in the grid; the others are not.
  const grid = page.getByRole('grid', { name: '记录表格' });
  await expect(grid).toContainText('苹果');
  await expect(grid).toContainText('梨');
  await expect(grid).not.toContainText('香蕉');
  await expect(grid).not.toContainText('橙子');

  // The import stays in the table's recent imports.
  await page.getByRole('main').getByRole('button', { name: '更多' }).first().click();
  await page.getByRole('menuitem', { name: '导入 CSV' }).click();
  await expect(drawer.getByRole('button', { name: /fruit\.csv/ })).toContainText('已导入 2 条 · 跳过 2 条');
});
