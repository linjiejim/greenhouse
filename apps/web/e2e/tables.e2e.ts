import { expect, test, type Locator, type Page } from '@playwright/test';
import { apiAs } from './api';
import { as, open } from './fixtures';

/** What these tests read of a view from the API. */
interface View {
  name: string;
  config: { filter?: { clauses: unknown[] }; sorts?: unknown[]; group?: unknown };
}

/** A base made from the 项目 template through the dialog, open on its 任务 table. */
async function projectBase(page: Page, name: string) {
  await open(page, '/#/tables');
  // The header's button (an empty list has a second one).
  await page.getByRole('main').getByRole('button', { name: '新建表格' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建表格' });
  await dialog.getByRole('radio', { name: /^项目/ }).click();
  await dialog.getByLabel('名称').fill(name);
  await dialog.getByRole('button', { name: '创建表格' }).click();
  await expect(page.getByRole('main').getByRole('heading', { level: 1, name })).toBeVisible();
  await page.getByRole('tablist', { name: '数据表' }).getByRole('tab', { name: '任务' }).click();
  const grid = page.getByRole('grid', { name: '记录表格' });
  await expect(grid).toContainText('需求调研');
  return grid;
}

/** A record's row, by its title: other rows may name it in a link. */
const row = (grid: Locator, title: string) =>
  grid
    .getByRole('row')
    .filter({ has: grid.page().locator('[aria-colindex="2"] .app-tb-cell-value').getByText(title, { exact: true }) });

/** The cell of a record (by its title) under a column (by its header). */
async function cell(grid: Locator, title: string, column: string) {
  const index = await grid.getByRole('columnheader', { name: column, exact: true }).getAttribute('aria-colindex');
  return row(grid, title).locator(`[aria-colindex="${index}"]`);
}

/** The base's id from the address. */
const baseIdOf = (page: Page) => /#\/tables\/(bas_[0-9A-Z]+)/.exec(page.url())?.[1] ?? '';

/** A day some days from today in Shanghai, as the tables write it: 「10 月 19 日」. */
function fromToday(days: number) {
  const now = new Date(Date.now() + 8 * 3_600_000);
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days));
  const year = day.getUTCFullYear() === now.getUTCFullYear() ? '' : `${day.getUTCFullYear()} 年 `;
  return `${year}${day.getUTCMonth() + 1} 月 ${day.getUTCDate()} 日`;
}

async function paste(target: Locator, text: string) {
  await target.evaluate((element, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

test('tables: a base from the 项目 template, a new field, typed cells and a pasted block', async ({ page }) => {
  const grid = await projectBase(page, 'E2E 产品计划');
  // The template: projects and tasks, tasks with four views.
  await expect(page.getByRole('tablist', { name: '数据表' }).getByRole('tab')).toHaveText(['项目', '任务']);
  await expect(page.getByRole('tablist', { name: '视图' }).getByRole('tab')).toHaveText([
    '表格',
    '看板',
    '时间线',
    '日历',
  ]);

  // A number field, added from the grid's header.
  await grid.getByRole('button', { name: '添加字段' }).click();
  const dialog = page.getByRole('dialog', { name: '添加字段' });
  await dialog.getByRole('textbox', { name: /^名称/ }).fill('预算');
  await dialog.getByRole('combobox', { name: '类型' }).click();
  await page.getByRole('option', { name: '数字' }).click();
  await dialog.getByRole('button', { name: '添加字段' }).click();
  await expect(dialog).toBeHidden();
  await expect(grid.getByRole('columnheader', { name: '预算', exact: true })).toBeVisible();

  // Typing into a cell replaces it; Enter saves.
  const budget = await cell(grid, '需求调研', '预算');
  await budget.click();
  await page.keyboard.type('1200');
  await page.keyboard.press('Enter');
  await expect(budget).toHaveText('1,200');

  // A block of two columns by two rows on the last record (上线): the row past the end becomes a new
  // record, and the linked project is found by its title.
  await (await cell(grid, '上线', '名称')).click();
  await paste(grid, '上线复盘\t示例项目\n发布公告\t示例项目');
  await expect(page.getByRole('status').filter({ hasText: '已粘贴 2 条' })).toBeVisible();
  await expect(await cell(grid, '上线复盘', '项目')).toHaveText('示例项目');
  await expect(await cell(grid, '发布公告', '项目')).toHaveText('示例项目');
  await page.reload();
  await expect(await cell(page.getByRole('grid', { name: '记录表格' }), '发布公告', '项目')).toHaveText('示例项目');
});

test('tables: filter, sort and group a new shared view that keeps its settings', async ({ page, request }) => {
  await projectBase(page, 'E2E 视图');
  await page.getByRole('button', { name: '新建视图' }).click();
  await page.getByRole('menuitem', { name: '表格' }).click();
  const dialog = page.getByRole('dialog', { name: '新建视图' });
  await dialog.getByRole('textbox', { name: /视图名称/ }).fill('进行中');
  await dialog.getByRole('radio', { name: '所有人' }).click();
  await dialog.getByRole('button', { name: '创建视图' }).click();
  await expect(page.getByRole('tablist', { name: '视图' }).getByRole('tab', { name: '进行中' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  await page.getByRole('button', { name: '筛选', exact: true }).click();
  const filter = page.getByRole('dialog', { name: '筛选' });
  await filter.getByRole('button', { name: '添加条件' }).click();
  await filter.getByRole('combobox', { name: '字段' }).click();
  await page.getByRole('option', { name: '状态' }).click();
  await filter.getByRole('combobox', { name: '值' }).click();
  await page.getByRole('option', { name: '进行中' }).click();
  await page.keyboard.press('Escape');
  await expect(filter).toBeHidden();

  await page.getByRole('button', { name: '排序', exact: true }).click();
  const sort = page.getByRole('dialog', { name: '排序' });
  await sort.getByRole('button', { name: '添加排序' }).click();
  await sort.getByRole('combobox', { name: '字段' }).click();
  await page.getByRole('option', { name: '截止日期' }).click();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '分组', exact: true }).click();
  const group = page.getByRole('dialog', { name: '分组' });
  await group.getByRole('combobox', { name: '分组字段' }).click();
  await page.getByRole('option', { name: '负责人' }).click();
  await page.keyboard.press('Escape');

  const grid = page.getByRole('grid', { name: '记录表格' });
  await expect(grid).toContainText('需求调研');
  await expect(grid).not.toContainText('首页设计');
  // Saved with the view (the saves go one after another): still there after a reload, for everyone.
  await expect
    .poll(async () => {
      const base = await apiAs<{ views: View[] }>(request, 'lin', 'GET', `/api/tables/bases/${baseIdOf(page)}`);
      const config = base.views.find((view) => view.name === '进行中')?.config;
      return [config?.filter?.clauses.length, config?.sorts?.length, !!config?.group];
    })
    .toEqual([1, 1, true]);
  await page.reload();
  await expect(page.getByRole('button', { name: '1 个筛选' })).toBeVisible();
  await expect(page.getByRole('button', { name: '1 个排序' })).toBeVisible();
  await expect(page.getByRole('button', { name: '按「负责人」分组' })).toBeVisible();
  await expect(page.getByRole('grid', { name: '记录表格' }).getByRole('button', { name: /Lin/ })).toBeVisible();
});

test('tables: a card dragged to another column of the board changes its status', async ({ page }) => {
  await projectBase(page, 'E2E 看板');
  await page.getByRole('tablist', { name: '视图' }).getByRole('tab', { name: '看板' }).click();
  const board = page.getByRole('group', { name: '记录看板' });
  const done = board.getByRole('group', { name: /^已完成，/ });
  await expect(done).toHaveAccessibleName('已完成，1 条');
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PATCH' && /\/api\/tables\/records\//.test(response.url()),
  );
  await board.getByRole('article', { name: '首页设计', exact: true }).dragTo(done);
  await expect(done.getByRole('article', { name: '首页设计', exact: true })).toBeVisible();
  await expect(done).toHaveAccessibleName('已完成，2 条');
  expect((await saved).ok()).toBe(true);
  await page.reload();
  await expect(
    page.getByRole('group', { name: /^已完成，/ }).getByRole('article', { name: '首页设计', exact: true }),
  ).toBeVisible();
});

test('tables: dragging a bar on the timeline moves its dates', async ({ page }) => {
  await projectBase(page, 'E2E 时间线');
  await page.getByRole('tablist', { name: '视图' }).getByRole('tab', { name: '时间线' }).click();
  const timeline = page.getByRole('region', { name: '时间线' });
  // 首页设计 runs from day 5 to day 8 of the sample project, under 设计; 上线 is a milestone.
  const bar = timeline.getByRole('button', { name: `首页设计：${fromToday(5)} 到 ${fromToday(8)}` });
  await expect(bar).toBeVisible();
  await expect(timeline.getByRole('button', { name: `上线：里程碑，${fromToday(26)}` })).toBeVisible();
  await expect(timeline.locator('.app-tb-tl-arrow')).not.toHaveCount(0);

  // Hovering waits until the bar stops moving; then three days to the right, grabbed by its middle.
  await bar.hover();
  const box = (await bar.boundingBox())!;
  const day = box.width / 4;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  const saved = page.waitForResponse(
    (response) => response.request().method() === 'PATCH' && /\/api\/tables\/records\//.test(response.url()),
  );
  await page.mouse.down();
  await page.mouse.move(x + day, y, { steps: 4 });
  await page.mouse.move(x + 3 * day, y, { steps: 4 });
  await page.mouse.up();
  const moved = `首页设计：${fromToday(8)} 到 ${fromToday(11)}`;
  await expect(timeline.getByRole('button', { name: moved })).toBeVisible();
  expect((await saved).ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole('region', { name: '时间线' }).getByRole('button', { name: moved })).toBeVisible();
});

test('tables: the record drawer edits in place, and comments mention people', async ({ page }) => {
  const grid = await projectBase(page, 'E2E 记录');
  await row(grid, '前端开发').getByRole('button', { name: '展开记录' }).click();
  const drawer = page.getByRole('dialog', { name: '前端开发' });
  await drawer.getByRole('button', { name: '编辑' }).click();
  await drawer.getByRole('combobox', { name: '优先级' }).click();
  await page.getByRole('option', { name: '低' }).click();
  await drawer.getByRole('textbox', { name: '说明' }).fill('先做首页');
  await drawer.getByRole('button', { name: '保存' }).click();
  await expect(drawer.getByRole('button', { name: '编辑' })).toBeVisible();
  await expect(drawer).toContainText('先做首页');
  await expect(drawer).toContainText('优先级：高 → 低');

  const box = drawer.getByRole('textbox', { name: /写评论/ });
  await box.click();
  await box.pressSequentially('请看一下 @Me');
  await page.getByRole('option', { name: 'Mei' }).click();
  await box.pressSequentially('谢谢');
  await drawer.getByRole('button', { name: '发表评论' }).click();
  await expect(drawer.locator('.app-tb-comment')).toContainText('请看一下 @Mei 谢谢');
  await expect(drawer.locator('.app-tb-mention')).toHaveText('@Mei');
});

test('tables: deleted records wait in the recycle bin and come back', async ({ page }) => {
  const grid = await projectBase(page, 'E2E 回收站');
  await row(grid, '后端接口')
    .getByRole('checkbox', { name: /选择第/ })
    .check();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已删除 1 条记录' })).toBeVisible();
  await expect(grid).not.toContainText('后端接口');

  await page.getByRole('main').getByRole('button', { name: '更多' }).first().click();
  await page.getByRole('menuitem', { name: '回收站' }).click();
  const bin = page.getByRole('dialog', { name: '回收站' });
  const item = bin.getByRole('listitem').filter({ hasText: '后端接口' });
  await expect(item).toContainText('记录 · 任务');
  await item.getByRole('button', { name: '恢复' }).click();
  await expect(bin.getByRole('listitem').filter({ hasText: '后端接口' })).toHaveCount(0);
  await bin.getByRole('button', { name: '关闭详情', exact: true }).click();
  await expect(grid).toContainText('后端接口');
});

test('tables: Mei, shared as a viewer, reads the base and cannot change it', async ({ page, browser, request }) => {
  await projectBase(page, 'E2E 只读');
  await page.getByRole('main').getByRole('button', { name: '更多' }).first().click();
  await page.getByRole('menuitem', { name: '分享' }).click();
  const share = page.getByRole('dialog', { name: '分享「E2E 只读」' });
  await share.getByRole('combobox', { name: '添加成员或分组' }).click();
  await page.getByRole('option', { name: /^Mei/ }).click();
  await share.getByRole('combobox', { name: '角色' }).click();
  await page.getByRole('option', { name: /^查看者/ }).click();
  await share.getByRole('button', { name: '添加' }).click();
  await share.getByRole('button', { name: '保存分享' }).click();
  await expect(share).toBeHidden();
  const baseId = baseIdOf(page);

  const context = await browser.newContext({ storageState: as('mei'), locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const mei = await context.newPage();
  await open(mei, `/#/tables/${baseId}`);
  await expect(mei.getByRole('main').getByText('只读', { exact: true })).toBeVisible();
  await expect(mei.getByRole('main').getByRole('button', { name: '添加记录' })).toHaveCount(0);
  await mei.getByRole('tablist', { name: '数据表' }).getByRole('tab', { name: '任务' }).click();
  const grid = mei.getByRole('grid', { name: '记录表格' });
  const title = await cell(grid, '需求调研', '名称');
  await title.dblclick();
  await expect(grid.getByRole('textbox')).toHaveCount(0);
  await row(grid, '需求调研').getByRole('button', { name: '展开记录' }).click();
  const drawer = mei.getByRole('dialog', { name: '需求调研' });
  await expect(drawer).toContainText('负责人');
  await expect(drawer.getByRole('button', { name: '编辑' })).toHaveCount(0);
  // The server says no as well.
  const base = await apiAs<{ tables: Array<{ id: string; name: string }> }>(
    request,
    'mei',
    'GET',
    `/api/tables/bases/${baseId}`,
  );
  const tasks = base.tables.find((table) => table.name === '任务')!;
  await expect(apiAs(request, 'mei', 'POST', `/api/tables/tables/${tasks.id}/records`, { values: {} })).rejects.toThrow(
    /403/,
  );
  await context.close();
});

test('tables: on a phone the grid is a list and a record opens as a sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/#/tables');
  await page.getByRole('main').getByRole('button', { name: '新建表格' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建表格' });
  await dialog.getByRole('radio', { name: /^项目/ }).click();
  await dialog.getByLabel('名称').fill('E2E 手机');
  await dialog.getByRole('button', { name: '创建表格' }).click();
  await page.getByRole('tablist', { name: '数据表' }).getByRole('tab', { name: '任务' }).click();
  const list = page.getByRole('list', { name: '记录表格' });
  await expect(list).toContainText('需求调研');
  await expect(page.getByRole('grid')).toHaveCount(0);
  await list.getByRole('button', { name: /需求调研/ }).click();
  const sheet = page.getByRole('dialog', { name: '需求调研' });
  await expect(sheet).toBeVisible();
  const box = await sheet.boundingBox();
  expect(box!.y).toBeGreaterThan(40);
  await sheet.getByRole('button', { name: '关闭详情', exact: true }).click();
  // The full grid is one tap away.
  await page.getByRole('button', { name: '切换完整表格' }).click();
  await expect(page.getByRole('grid', { name: '记录表格' })).toBeVisible();
});
