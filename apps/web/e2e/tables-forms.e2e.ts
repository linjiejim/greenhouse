import { expect, test, type APIRequestContext } from '@playwright/test';
import { apiAs } from './api';
import { as, open } from './fixtures';

/** What these tests read of a base and a form from the API. */
interface Base {
  id: string;
  tables: Array<{ id: string; name: string; fields: Array<{ id: string; name: string }> }>;
}
interface Form {
  id: string;
}

/** Lin's base of requests: a title, a count and files; Mei edits it when asked. */
async function requestsBase(request: APIRequestContext, name: string, options: { meiEdits?: boolean } = {}) {
  const base = await apiAs<Base>(request, 'lin', 'POST', '/api/tables/bases', { name });
  const table = base.tables[0]!;
  const field = (body: object) =>
    apiAs<{ id: string }>(request, 'lin', 'POST', `/api/tables/tables/${table.id}/fields`, body);
  const count = await field({ name: '数量', type: 'number' });
  const files = await field({ name: '附件', type: 'attachment' });
  if (options.meiEdits) {
    const mei = await apiAs<{ id: string }>(request, 'mei', 'GET', '/api/me');
    await apiAs(request, 'lin', 'PUT', `/api/tables/bases/${base.id}/share`, {
      items: [{ type: 'member', id: mei.id, role: 'editor' }],
    });
  }
  return { base, table, primary: table.fields[0]!, count, files };
}

test('forms: a builder makes a form from a table, publishes and shares it, and Mei submits it with a file', async ({
  page,
  browser,
  request,
}) => {
  const { base, table, primary, count, files } = await requestsBase(request, 'E2E 表单');
  await open(page, `/#/tables/${base.id}`);
  await page.getByRole('main').getByRole('button', { name: '更多' }).first().click();
  await page.getByRole('menuitem', { name: '表单' }).click();
  const drawer = page.getByRole('dialog', { name: `「${table.name}」的表单` });
  await expect(drawer.getByText('还没有表单')).toBeVisible();
  await drawer.getByRole('button', { name: '新建表单' }).click();
  const naming = page.getByRole('dialog', { name: '新建表单' });
  await naming.getByRole('textbox', { name: '名称' }).fill('采购申请');
  await naming.getByRole('button', { name: '创建表单' }).click();
  await expect(naming).toBeHidden();

  // It opens in the builder with the table's fields: 数量 becomes required, with a line of help.
  await drawer.getByRole('checkbox', { name: '「数量」必填' }).check();
  await drawer.getByRole('textbox', { name: '「数量」的说明' }).fill('要几个');
  await drawer.getByRole('textbox', { name: '提交后显示' }).fill('收到，会尽快采购');
  await drawer.getByRole('button', { name: '保存' }).click();
  await expect(drawer.getByRole('button', { name: '编辑' })).toBeVisible();
  await expect(drawer).toContainText('要几个');
  await drawer.getByRole('button', { name: '发布' }).click();
  await expect(drawer.getByRole('button', { name: '复制链接' })).toBeVisible();
  await expect(drawer.getByText('已发布', { exact: true })).toBeVisible();

  // Shared with Mei alone; by default the table's editors would submit.
  await drawer.getByRole('button', { name: '分享' }).click();
  const share = page.getByRole('dialog', { name: '谁可以提交「采购申请」' });
  await expect(share).toContainText('默认：这张数据表的编辑者可以提交');
  await share.getByRole('combobox', { name: '添加成员或分组' }).click();
  await page.getByRole('option', { name: /^Mei/ }).click();
  await share.getByRole('button', { name: '添加' }).click();
  await share.getByRole('button', { name: '保存' }).click();
  await expect(share).toBeHidden();
  await expect(drawer).toContainText('分享给：Mei');

  const { items } = await apiAs<{ items: Form[] }>(request, 'lin', 'GET', `/api/tables/tables/${table.id}/forms`);
  const formId = items[0]!.id;

  // Mei has no part in the base, and fills the form in.
  const context = await browser.newContext({ storageState: as('mei'), locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const mei = await context.newPage();
  await open(mei, `/#/forms/${formId}`);
  const form = mei.getByRole('main');
  await expect(form.getByRole('heading', { level: 1, name: '采购申请' })).toBeVisible();
  await form.getByRole('textbox', { name: /^名称/ }).fill('打印纸');
  await form.getByRole('button', { name: '提交表单' }).click();
  await expect(form.getByText('这一项必填')).toBeVisible();
  await form.getByRole('textbox', { name: /^数量/ }).fill('3');
  await form.locator('input[type="file"]').setInputFiles({
    name: 'quote.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('A4 x 3'),
  });
  await expect(form.getByText('quote.txt')).toBeVisible();
  await form.getByRole('button', { name: '提交表单' }).click();
  await expect(form.getByText('收到，会尽快采购')).toBeVisible();
  await expect(form.getByRole('button', { name: '再填一份' })).toBeVisible();
  await context.close();

  // The record is in the table with its file.
  const records = await apiAs<{ items: Array<{ values: Record<string, unknown> }> }>(
    request,
    'lin',
    'POST',
    `/api/tables/tables/${table.id}/records/query`,
    {},
  );
  const record = records.items.find((item) => item.values[primary.id] === '打印纸');
  expect(record?.values[count.id]).toBe(3);
  expect(record?.values[files.id]).toHaveLength(1);

  // Lin finds the submission in the drawer and opens its record.
  await drawer.getByRole('tab', { name: '提交记录' }).click();
  await expect(drawer.getByRole('list', { name: '提交记录' })).toContainText('Mei');
  await drawer.getByRole('button', { name: '打印纸' }).click();
  await expect(page.getByRole('dialog', { name: '打印纸' })).toBeVisible();
});

test('forms: a single-submit form takes one submission from each person', async ({ browser, request }) => {
  const { table, primary } = await requestsBase(request, 'E2E 单次表单', { meiEdits: true });
  const made = await apiAs<Form>(request, 'lin', 'POST', `/api/tables/tables/${table.id}/forms`, {
    name: '报名',
    config: { fields: [{ field_id: primary.id, label: '姓名', required: true }], single_submit: true },
  });
  await apiAs(request, 'lin', 'POST', `/api/tables/forms/${made.id}/publish`);

  // Mei edits the base, so she may submit by default.
  const context = await browser.newContext({ storageState: as('mei'), locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const mei = await context.newPage();
  await open(mei, `/#/forms/${made.id}`);
  const form = mei.getByRole('main');
  await form.getByRole('textbox', { name: /^姓名/ }).fill('Mei');
  await form.getByRole('button', { name: '提交表单' }).click();
  await expect(form.getByText('已提交，谢谢')).toBeVisible();
  await expect(form.getByRole('button', { name: '再填一份' })).toHaveCount(0);

  // Opened again it says so, and the server refuses a second one.
  await mei.reload();
  await expect(form.getByText('你已经提交过')).toBeVisible();
  await expect(form.getByRole('button', { name: '提交表单' })).toHaveCount(0);
  await expect(
    apiAs(request, 'mei', 'POST', `/api/tables/forms/${made.id}/submissions`, { values: { [primary.id]: '再来' } }),
  ).rejects.toThrow(/409/);
  await context.close();
});
