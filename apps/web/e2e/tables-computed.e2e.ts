import { expect, test, type Locator, type Page, type APIRequestContext } from '@playwright/test';
import type { Base, BaseTable, Field, RecordDetail, TableRecord } from '@greenhouse/contract';
import { apiAs } from './api';
import { as, open } from './fixtures';

const gridOf = (page: Page) => page.getByRole('grid', { name: '记录表格' });
const rowOf = (grid: Locator, title: string) =>
  grid
    .getByRole('row')
    .filter({ has: grid.page().locator('[aria-colindex="2"] .app-tb-cell-value').getByText(title, { exact: true }) });
async function cellOf(grid: Locator, title: string, field: string) {
  const col = await grid.getByRole('columnheader', { name: field, exact: true }).getAttribute('aria-colindex');
  return rowOf(grid, title).locator(`[aria-colindex="${col}"]`);
}
async function baseWith(request: APIRequestContext, name: string) {
  const made = await apiAs<Base>(request, 'lin', 'POST', '/api/tables/bases', { name });
  const base = await apiAs<Base>(request, 'lin', 'GET', `/api/tables/bases/${made.id}`);
  return { base, table: base.tables[0]! };
}
const field = (request: APIRequestContext, table: BaseTable, name: string, type: string, config = {}) =>
  apiAs<Field>(request, 'lin', 'POST', `/api/tables/tables/${table.id}/fields`, { name, type, config });
const record = (request: APIRequestContext, table: BaseTable, values: Record<string, unknown>) =>
  apiAs<RecordDetail>(request, 'lin', 'POST', `/api/tables/tables/${table.id}/records`, { values });
async function fieldDialog(page: Page, name: string, type: string) {
  await gridOf(page).getByRole('button', { name: '添加字段' }).click();
  const dialog = page.getByRole('dialog', { name: '添加字段' });
  await dialog.getByRole('textbox', { name: /^名称/ }).fill(name);
  await dialog.getByRole('combobox', { name: '类型' }).click();
  await page.getByRole('option', { name: type, exact: true }).click();
  return dialog;
}
async function choose(page: Page, dialog: Locator, label: string, option: string) {
  await dialog.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test('tables: formula, lookup and rollup follow edits, computed cells stay read only', async ({ page, request }) => {
  test.setTimeout(60_000);
  const { base, table } = await baseWith(request, 'E2E 计算字段');
  const price = await field(request, table, '金额', 'number');
  const sources = await apiAs<BaseTable>(request, 'lin', 'POST', `/api/tables/bases/${base.id}/tables`, {
    name: '来源',
  });
  const amount = await field(request, sources, '价格', 'number');
  const source = await record(request, sources, { [sources.fields[0]!.id]: '单价', [amount.id]: 10 });
  const relation = await field(request, table, '来源关联', 'relation', { table_id: sources.id, multiple: true });
  await record(request, table, { [table.fields[0]!.id]: '总价', [price.id]: 3, [relation.id]: [source.record.id] });
  await open(page, `/#/tables/${base.id}/${table.id}`);
  let dialog = await fieldDialog(page, '翻倍', '公式');
  await dialog.getByRole('textbox', { name: '公式' }).fill('{不存在} * 2');
  await dialog.getByRole('button', { name: '添加字段' }).click();
  await expect(dialog).toContainText('找不到引用的字段');
  await expect(dialog.locator('mark')).toHaveText('{不存在}');
  await dialog.getByRole('textbox', { name: '公式' }).fill('{金额} * 2');
  await dialog.getByRole('button', { name: '添加字段' }).click();
  await expect(dialog).toBeHidden();
  dialog = await fieldDialog(page, '引用价格', '查找引用');
  await choose(page, dialog, '关联字段', '来源关联');
  await choose(page, dialog, '引用字段', '价格');
  await dialog.getByRole('button', { name: '添加字段' }).click();
  await expect(dialog).toBeHidden();
  dialog = await fieldDialog(page, '价格合计', '汇总');
  await choose(page, dialog, '关联字段', '来源关联');
  await choose(page, dialog, '引用字段', '价格');
  await choose(page, dialog, '汇总方式', '求和');
  await dialog.getByRole('button', { name: '添加字段' }).click();
  await expect(dialog).toBeHidden();
  const grid = gridOf(page);
  await expect(await cellOf(grid, '总价', '翻倍')).toHaveText('6');
  await expect(await cellOf(grid, '总价', '引用价格')).toHaveText('10');
  await expect(await cellOf(grid, '总价', '价格合计')).toHaveText('10');
  const doubled = await cellOf(grid, '总价', '翻倍');
  await doubled.dblclick();
  await expect(grid.getByRole('textbox')).toHaveCount(0);
  await page.keyboard.press('Delete');
  await expect(doubled).toHaveText('6');
  const numeric = await cellOf(grid, '总价', '金额');
  await numeric.dblclick();
  await grid.getByRole('textbox', { name: '金额' }).fill('4');
  await page.keyboard.press('Enter');
  await expect(doubled).toHaveText('8');
  // Another table is edited while this view and drawer stay open: revision is unchanged,
  // computed_revision changes in the cascade job and both visible surfaces must refresh.
  await rowOf(grid, '总价').getByRole('button', { name: '展开记录' }).click();
  const drawer = page.getByRole('dialog', { name: '总价' });
  await apiAs(request, 'lin', 'PATCH', `/api/tables/records/${source.record.id}`, {
    revision: source.record.revision,
    values: { [amount.id]: 25 },
  });
  await expect(
    drawer.locator('.app-tb-record-field').filter({ has: page.locator('dt').getByText('价格合计', { exact: true }) }),
  ).toContainText('25');
  await drawer.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(drawer.getByRole('textbox', { name: '翻倍' })).toHaveCount(0);
  await drawer.getByRole('textbox', { name: /金额/ }).fill('5');
  await page.goBack();
  const discard = page.getByRole('alertdialog');
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: '取消', exact: true }).click();
  await expect(discard).toBeHidden();
  await expect(drawer.getByRole('textbox', { name: /金额/ })).toHaveValue('5');
  await drawer.getByRole('button', { name: '保存', exact: true }).click();
  await expect(drawer.getByRole('button', { name: '编辑', exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: '关闭详情', exact: true }).click();
  await expect(await cellOf(grid, '总价', '引用价格')).toHaveText('25');
  await expect(await cellOf(grid, '总价', '价格合计')).toHaveText('25');
  await expect(doubled).toHaveText('10');
});

test('tables: AI fields generate with the configured model and can be regenerated', async ({ page, request }) => {
  const { base, table } = await baseWith(request, 'E2E AI 字段');
  const made = await record(request, table, { [table.fields[0]!.id]: '桃子' });
  await open(page, `/#/tables/${base.id}/${table.id}`);
  const dialog = await fieldDialog(page, '摘要', 'AI 字段');
  await dialog.getByRole('textbox', { name: '提示词' }).fill('概括：');
  await choose(page, dialog, '插入字段引用', table.fields[0]!.name);
  await expect(dialog.getByRole('textbox', { name: '提示词' })).toHaveValue(`概括：{${table.fields[0]!.name}}`);
  await dialog.getByRole('button', { name: '添加字段' }).click();
  await expect(dialog).toBeHidden();
  await rowOf(gridOf(page), '桃子').getByRole('button', { name: '展开记录' }).click();
  const drawer = page.getByRole('dialog', { name: '桃子' });
  const generated = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/generate'),
  );
  await drawer.getByRole('button', { name: '重新生成' }).click();
  expect((await generated).ok()).toBe(true);
  await expect(drawer.getByText('生成中', { exact: true })).toHaveCount(0, { timeout: 15_000 });
  await expect(
    drawer.locator('.app-tb-record-field').filter({ has: page.locator('dt').getByText('摘要', { exact: true }) }),
  ).toContainText('桃子', { timeout: 15_000 });
  const current = await apiAs<RecordDetail>(request, 'lin', 'GET', `/api/tables/records/${made.record.id}`);
  expect(current.record.computed_revision).toBeGreaterThan(made.record.computed_revision);
});

test('tables: custom role hides rows and columns from Mei in grid, drawer, search and export', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(60_000);
  const { base, table } = await baseWith(request, 'E2E 行列权限');
  const secret = await field(request, table, '机密字段', 'text');
  const dependent = await field(request, table, '引用机密', 'formula', { formula_text: '{机密字段}' });
  const visible = await record(request, table, { [table.fields[0]!.id]: '可见记录琥珀', [secret.id]: '隐藏词蓝宝石' });
  const hidden = await record(request, table, { [table.fields[0]!.id]: '不可见记录钻石', [secret.id]: '隐藏词翡翠' });
  await open(page, `/#/tables/${base.id}/${table.id}`);
  await page.getByRole('main').getByRole('button', { name: '更多', exact: true }).first().click();
  await page.getByRole('menuitem', { name: '自定义角色' }).click();
  const roles = page.getByRole('dialog', { name: '自定义角色' });
  await roles.getByRole('button', { name: '新建角色' }).click();
  await roles.getByRole('textbox', { name: /角色名称/ }).fill('受限读者');
  const rules = roles.getByRole('region', { name: table.name });
  await choose(page, rules, '数据表权限', '只读');
  await rules.getByRole('button', { name: '添加条件' }).click();
  await rules.getByRole('textbox', { name: '值', exact: true }).fill('可见记录琥珀');
  await rules.getByRole('checkbox', { name: '机密字段', exact: true }).uncheck();
  await roles.getByRole('button', { name: '保存角色' }).click();
  await expect(roles.getByText('受限读者', { exact: true })).toBeVisible();
  await roles.getByRole('button', { name: '编辑角色' }).click();
  await roles.getByRole('textbox', { name: '说明' }).fill('仅限琥珀');
  await roles.getByRole('button', { name: '保存角色' }).click();
  await expect(roles.getByRole('button', { name: '编辑角色' })).toBeVisible();
  await expect(roles).toContainText('仅限琥珀');
  await roles.getByRole('button', { name: '关闭详情', exact: true }).click();
  await expect(roles).toBeHidden();
  await page.getByRole('main').getByRole('button', { name: '更多', exact: true }).first().click();
  await page.getByRole('menuitem', { name: '分享', exact: true }).click();
  const share = page.getByRole('dialog', { name: `分享「${base.name}」` });
  await share.getByRole('combobox', { name: '添加成员或分组' }).click();
  await page.getByRole('option', { name: /^Mei/ }).click();
  await share.getByRole('combobox', { name: '角色', exact: true }).click();
  await page.getByRole('option', { name: /^受限读者/ }).click();
  await share.getByRole('button', { name: '添加', exact: true }).click();
  await share.getByRole('button', { name: '保存分享' }).click();
  await expect(share).toBeHidden();
  const context = await browser.newContext({ storageState: as('mei'), locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const mei = await context.newPage();
  await open(mei, `/#/tables/${base.id}/${table.id}`);
  const grid = gridOf(mei);
  await expect(grid).toContainText('可见记录琥珀');
  await expect(grid).not.toContainText('不可见记录钻石');
  await expect(grid.getByRole('columnheader', { name: '机密字段' })).toHaveCount(0);
  await expect(grid.getByRole('columnheader', { name: dependent.name })).toHaveCount(0);
  await expect(mei.getByText('1 条记录', { exact: true })).toBeVisible();
  await rowOf(grid, '可见记录琥珀').getByRole('button', { name: '展开记录' }).click();
  const drawer = mei.getByRole('dialog', { name: '可见记录琥珀' });
  await expect(drawer).not.toContainText('机密字段');
  await expect(drawer).not.toContainText('隐藏词蓝宝石');
  await drawer.getByRole('button', { name: '关闭详情', exact: true }).click();
  await mei.keyboard.press('ControlOrMeta+k');
  const search = mei.getByRole('dialog');
  const input = search.getByRole('combobox');
  const hiddenSearch = mei.waitForResponse(
    (response) =>
      response.url().includes('/api/search?') && response.url().includes(encodeURIComponent('不可见记录钻石')),
  );
  await input.fill('不可见记录钻石');
  expect(JSON.stringify(await (await hiddenSearch).json())).not.toContain('不可见记录钻石');
  await expect(search.getByRole('listbox', { name: '结果' })).not.toContainText('不可见记录钻石');
  const columnSearch = mei.waitForResponse(
    (response) =>
      response.url().includes('/api/search?') && response.url().includes(encodeURIComponent('隐藏词蓝宝石')),
  );
  await input.fill('隐藏词蓝宝石');
  expect(JSON.stringify(await (await columnSearch).json())).not.toContain('可见记录琥珀');
  await expect(search.getByRole('listbox', { name: '结果' })).not.toContainText('可见记录琥珀');
  await input.fill('可见记录琥珀');
  await expect(search.getByRole('option', { name: /可见记录琥珀/ })).toBeVisible();
  await mei.keyboard.press('Escape');
  await mei.getByRole('main').getByRole('button', { name: '更多', exact: true }).first().click();
  const download = mei.waitForEvent('download');
  await mei.getByRole('menuitem', { name: '导出 CSV' }).click();
  const stream = await (await download).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const csv = Buffer.concat(chunks).toString('utf8');
  expect(csv).toContain('可见记录琥珀');
  expect(csv).not.toMatch(/机密字段|引用机密|蓝宝石|钻石/);
  await expect(apiAs(request, 'mei', 'GET', `/api/tables/records/${hidden.record.id}`)).rejects.toThrow(/404|403/);
  await apiAs<RecordDetail>(request, 'mei', 'GET', `/api/tables/records/${visible.record.id}`);
  // Readers can create a personal dashboard from the same tab menu.
  await mei.getByRole('button', { name: '新建数据表或仪表盘' }).click();
  await expect(mei.getByRole('menuitem', { name: '新建数据表', exact: true })).toHaveCount(0);
  await mei.getByRole('menuitem', { name: '新建仪表盘' }).click();
  await mei.getByRole('dialog', { name: '新建仪表盘' }).getByRole('button', { name: '创建仪表盘' }).click();
  await expect(mei.getByText('还没有卡片')).toBeVisible();
  await context.close();
  await page.getByRole('main').getByRole('button', { name: '更多', exact: true }).first().click();
  await page.getByRole('menuitem', { name: '自定义角色' }).click();
  await roles.getByRole('button', { name: '删除角色' }).click();
  await page
    .getByRole('alertdialog', { name: '删除角色「受限读者」？' })
    .getByRole('button', { name: '删除角色', exact: true })
    .click();
  await expect(roles.getByText('还没有自定义角色')).toBeVisible();
  const shares = await apiAs<{ items: unknown[] }>(request, 'lin', 'GET', `/api/tables/bases/${base.id}/share`);
  expect(shares.items).toHaveLength(0);
});

test('tables: URL cells only link http(s), email addresses cannot inject mailto headers', async ({ page, request }) => {
  const { base, table } = await baseWith(request, 'E2E 安全链接');
  const url = await field(request, table, '地址', 'url');
  const email = await field(request, table, '邮箱', 'email');
  const address = 'mei+note@example.com?subject=Injected&body=bad';
  const made = await record(request, table, {
    [table.fields[0]!.id]: '链接测试',
    [url.id]: 'https://example.com/path',
    [email.id]: address,
  });
  await open(page, `/#/tables/${base.id}/${table.id}`);
  const grid = gridOf(page);
  await expect((await cellOf(grid, '链接测试', '地址')).getByRole('link')).toHaveAttribute(
    'href',
    'https://example.com/path',
  );
  await expect((await cellOf(grid, '链接测试', '邮箱')).getByRole('link')).toHaveAttribute(
    'href',
    `mailto:${encodeURIComponent(address)}`,
  );
  // The API already refuses unsafe URLs. Simulate an untrusted old query result to also
  // exercise the web renderer's defense, rather than weakening the real API fixture.
  await page.route(`**/api/tables/tables/${table.id}/records/query`, async (route) => {
    const response = await route.fetch();
    const data = (await response.json()) as { items: TableRecord[] };
    data.items.find((item) => item.id === made.record.id)!.values[url.id] = 'javascript:alert(1)';
    await route.fulfill({ response, json: data });
  });
  await page.reload();
  const unsafe = await cellOf(grid, '链接测试', '地址');
  await expect(unsafe).toHaveText('javascript:alert(1)');
  await expect(unsafe.getByRole('link')).toHaveCount(0);
});
