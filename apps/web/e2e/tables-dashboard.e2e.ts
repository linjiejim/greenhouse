import { expect, test, type Page } from '@playwright/test';
import { apiAs } from './api';
import { open } from './fixtures';

/** A base made from the 项目 template through the dialog. */
async function projectBase(page: Page, name: string) {
  await open(page, '/#/tables');
  // The header's button (an empty list has a second one).
  await page.getByRole('main').getByRole('button', { name: '新建表格' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建表格' });
  await dialog.getByRole('radio', { name: /^项目/ }).click();
  await dialog.getByLabel('名称').fill(name);
  await dialog.getByRole('button', { name: '创建表格' }).click();
  await expect(page.getByRole('main').getByRole('heading', { level: 1, name })).toBeVisible();
}

/** The base's id from the address. */
const baseIdOf = (page: Page) => /#\/tables\/(bas_[0-9A-Z]+)/.exec(page.url())?.[1] ?? '';

test('tables: a dashboard counts tasks and charts them by status, and follows a change to a record', async ({
  page,
  request,
}) => {
  await projectBase(page, 'E2E 仪表盘');
  const tabs = page.getByRole('tablist', { name: '数据表' });

  // A shared dashboard from the tabs' 「+」, opened at once and empty.
  await page.getByRole('button', { name: '新建数据表或仪表盘' }).click();
  await page.getByRole('menuitem', { name: '新建仪表盘' }).click();
  const naming = page.getByRole('dialog', { name: '新建仪表盘' });
  await naming.getByRole('textbox', { name: /仪表盘名称/ }).fill('进度');
  await naming.getByRole('button', { name: '创建仪表盘' }).click();
  await expect(tabs.getByRole('tab', { name: '进度' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('还没有卡片')).toBeVisible();

  // A number card: how many tasks there are.
  await page.getByRole('button', { name: '添加卡片' }).click();
  let editor = page.getByRole('dialog', { name: '添加卡片' });
  await editor.getByRole('textbox', { name: '标题' }).fill('任务总数');
  await editor.getByRole('combobox', { name: '数据表' }).click();
  await page.getByRole('option', { name: '任务', exact: true }).click();
  await expect(editor.locator('.app-tb-dash-figure')).toHaveText('9');
  await editor.getByRole('button', { name: '添加卡片' }).click();
  await expect(editor).toBeHidden();
  const total = page.getByRole('region', { name: '任务总数' });
  await expect(total.locator('.app-tb-dash-figure')).toHaveText('9');

  // A bar card: tasks by 状态, in the options' order.
  await page.getByRole('button', { name: '添加卡片' }).click();
  editor = page.getByRole('dialog', { name: '添加卡片' });
  await editor.getByRole('textbox', { name: '标题' }).fill('按状态');
  await editor.getByRole('radio', { name: '柱状图' }).click();
  await editor.getByRole('combobox', { name: '数据表' }).click();
  await page.getByRole('option', { name: '任务', exact: true }).click();
  await editor.getByRole('combobox', { name: '分组' }).click();
  await page.getByRole('option', { name: '状态', exact: true }).click();
  await editor.getByRole('button', { name: '添加卡片' }).click();
  await expect(editor).toBeHidden();
  const bars = page.getByRole('region', { name: '按状态' }).getByRole('list', { name: '按状态' });
  await expect(bars.getByRole('listitem')).toHaveText([/^待开始\s*7$/, /^进行中\s*1$/, /^已完成\s*1$/]);

  // 首页设计 moves to 已完成 on the board; back on the dashboard the bars follow.
  await tabs.getByRole('tab', { name: '任务' }).click();
  await page.getByRole('tablist', { name: '视图' }).getByRole('tab', { name: '看板' }).click();
  const board = page.getByRole('group', { name: '记录看板' });
  const done = board.getByRole('group', { name: /^已完成，/ });
  await expect(done).toHaveAccessibleName('已完成，1 条');
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PATCH' && /\/api\/tables\/records\//.test(response.url()),
  );
  await board.getByRole('article', { name: '首页设计', exact: true }).dragTo(done);
  expect((await saved).ok()).toBe(true);
  await tabs.getByRole('tab', { name: '进度' }).click();
  await expect(bars.getByRole('listitem')).toHaveText([/^待开始\s*6$/, /^进行中\s*1$/, /^已完成\s*2$/]);
  await expect(total.locator('.app-tb-dash-figure')).toHaveText('9');

  // A new task without a status: one more in the count, and a group of its own.
  const base = await apiAs<{
    tables: Array<{ id: string; name: string; fields: Array<{ id: string; is_primary: boolean }> }>;
  }>(request, 'lin', 'GET', `/api/tables/bases/${baseIdOf(page)}`);
  const tasks = base.tables.find((table) => table.name === '任务')!;
  const title = tasks.fields.find((field) => field.is_primary)!;
  await apiAs(request, 'lin', 'POST', `/api/tables/tables/${tasks.id}/records`, {
    values: { [title.id]: '复盘' },
  });
  await page.reload();
  await expect(page.getByRole('region', { name: '任务总数' }).locator('.app-tb-dash-figure')).toHaveText('10');
  await expect(
    page.getByRole('region', { name: '按状态' }).getByRole('list', { name: '按状态' }).getByRole('listitem'),
  ).toHaveText([/^待开始\s*6$/, /^进行中\s*1$/, /^已完成\s*2$/, /^（空）\s*1$/]);
});
