import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AppDraft, Base, MemberSummary } from '@greenhouse/contract';
import { apiAs } from './api';
import { as, open } from './fixtures';

test.use({ actionTimeout: 15_000 });

async function pick(page: Page, box: Locator, label: string, option: string) {
  await box.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
async function addCard(page: Page, kind: string, name: string) {
  await page.locator('.app-ap-canvas').getByRole('button', { name: '添加卡片', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '添加卡片', exact: true });
  await pick(page, dialog, '卡片类型', kind);
  await dialog.getByRole('button', { name: '添加卡片', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '编辑卡片', exact: true });
  await dialog.getByRole('textbox', { name: '卡片标题' }).fill(name);
  return dialog;
}
async function saveCard(page: Page) {
  const dialog = page.getByRole('dialog', { name: '编辑卡片', exact: true });
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('apps: build and publish for Mei, use list/detail/form/action, hide a field, restore and install a reviewed template', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(120_000);
  const base = await apiAs<Base>(request, 'lin', 'POST', '/api/tables/bases', { name: 'E2E 应用底座' });
  const table = base.tables[0]!;
  const title = table.fields[0]!;
  const state = await apiAs<{ id: string }>(request, 'lin', 'POST', `/api/tables/tables/${table.id}/fields`, {
    name: '状态',
    type: 'text',
  });
  const secret = await apiAs<{ id: string }>(request, 'lin', 'POST', `/api/tables/tables/${table.id}/fields`, {
    name: '机密',
    type: 'text',
  });
  const people = await apiAs<{ items: MemberSummary[] }>(request, 'lin', 'GET', '/api/members');
  const mei = people.items.find((p) => p.name === 'Mei')!;
  await apiAs(request, 'lin', 'PUT', `/api/tables/bases/${base.id}/share`, {
    items: [{ type: 'member', id: mei.id, role: 'editor' }],
  });
  await apiAs(request, 'lin', 'POST', `/api/tables/tables/${table.id}/records`, {
    values: { [title.id]: '已有申请', [state.id]: '待办', [secret.id]: '仅拥有者能看到' },
  });
  await open(page, '/#/apps');
  await page.getByRole('main').getByRole('button', { name: '新建应用', exact: true }).click();
  const naming = page.getByRole('dialog', { name: '新建应用', exact: true });
  await naming.getByRole('textbox', { name: '应用名称' }).fill('E2E 申请应用');
  await pick(page, naming, '使用的表格', 'E2E 应用底座');
  await naming.getByRole('button', { name: '新建应用', exact: true }).click();
  await expect(page.getByRole('main').getByRole('heading', { level: 1, name: 'E2E 申请应用' })).toBeVisible();
  const id = /#\/apps\/(app_[0-9A-Z]+)\/edit/.exec(page.url())![1]!;
  let editor = await addCard(page, '记录列表', '申请列表');
  await editor.getByRole('button', { name: '添加动作' }).click();
  await editor.getByRole('textbox', { name: '动作名称' }).fill('完成申请');
  await pick(page, editor, '写入字段', '状态');
  await page.keyboard.press('Escape');
  await editor.getByRole('textbox', { name: '状态', exact: true }).fill('已完成');
  await saveCard(page);
  await addCard(page, '表单', '新申请');
  await saveCard(page);
  editor = await addCard(page, '按钮', '快捷申请');
  await editor.getByRole('textbox', { name: '动作名称' }).fill('创建快捷申请');
  await pick(page, editor, '写入字段', title.name);
  await page.keyboard.press('Escape');
  await editor.getByRole('textbox', { name: title.name, exact: true }).fill('快捷申请记录');
  await saveCard(page);
  await page.getByRole('tab', { name: '角色', exact: true }).click();
  await page.getByRole('button', { name: '添加角色' }).click();
  await page.getByRole('textbox', { name: '角色名称' }).fill('申请人');
  await pick(page, page.getByRole('main'), `${table.name} · 数据表权限`, '可编辑');
  await pick(page, page.getByRole('main'), `${table.name} · 隐藏字段`, '机密');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: '受众', exact: true }).click();
  await pick(page, page.getByRole('main'), '成员与分组', 'Mei');
  await page.keyboard.press('Escape');
  await pick(page, page.getByRole('main'), '使用角色', '申请人');
  await page.getByRole('main').getByRole('button', { name: '发布应用', exact: true }).click();
  const publishing = page.getByRole('dialog', { name: '确认发布' });
  await publishing.getByRole('button', { name: '发布应用', exact: true }).click();
  await expect(publishing).toBeHidden();
  const meiContext = await browser.newContext({ storageState: as('mei') });
  const meiPage = await meiContext.newPage();
  try {
    await open(meiPage, '/#/notifications?view=all');
    await meiPage
      .getByRole('main')
      .getByRole('link', { name: /E2E 申请应用/ })
      .first()
      .click();
    await expect(meiPage).toHaveURL(new RegExp(`#/apps/${id}$`));
    await expect(meiPage.getByText('已有申请', { exact: true })).toBeVisible();
    await expect(meiPage.getByText('机密', { exact: true })).toHaveCount(0);
    await expect(meiPage.getByText('仅拥有者能看到')).toHaveCount(0);
    await meiPage.getByRole('button', { name: '已有申请', exact: true }).click();
    const detail = meiPage.getByRole('dialog', { name: '已有申请', exact: true });
    await expect(detail.getByText('状态', { exact: true })).toBeVisible();
    await expect(detail.getByText('机密', { exact: true })).toHaveCount(0);
    await meiPage.keyboard.press('Escape');
    await expect(detail).toBeHidden();
    await meiPage.getByRole('button', { name: '完成申请', exact: true }).click();
    await meiPage.getByRole('alertdialog').getByRole('button', { name: '执行', exact: true }).click();
    await expect(meiPage.getByText('已完成', { exact: true })).toBeVisible();
    const form = meiPage.getByRole('form', { name: '新申请', exact: true });
    await form.getByRole('textbox', { name: title.name, exact: true }).fill('表单申请记录');
    await form.getByRole('textbox', { name: '状态', exact: true }).fill('待办');
    await form.getByRole('button', { name: '提交表单' }).click();
    await expect(form).toBeHidden();
    await expect(meiPage.getByText('已提交', { exact: true })).toBeVisible();
    await meiPage.getByRole('button', { name: '创建快捷申请' }).click();
    await meiPage.getByRole('alertdialog').getByRole('button', { name: '执行', exact: true }).click();
    await expect(meiPage.getByRole('button', { name: '快捷申请记录', exact: true })).toBeVisible();
  } finally {
    await meiContext.close().catch(() => undefined);
  }
  // A second publication then restoration of version 1 leaves the live version alone.
  await page.getByRole('tab', { name: '页面', exact: true }).click();
  await page.getByRole('textbox', { name: '页面名称', exact: true }).fill('第二版页面');
  await page.getByRole('main').getByRole('button', { name: '发布应用', exact: true }).click();
  await page.getByRole('dialog', { name: '确认发布' }).getByRole('button', { name: '发布应用', exact: true }).click();
  await page.getByRole('main').getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('menuitem', { name: '版本历史' }).click();
  const history = page.getByRole('dialog', { name: '版本历史' });
  await history
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: '版本 1', exact: true }) })
    .getByRole('button', { name: '恢复到草稿' })
    .click();
  await expect(history).toBeHidden();
  await expect(page.getByRole('textbox', { name: '页面名称', exact: true })).toHaveValue('E2E 申请应用');
  await page.getByRole('main').getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('menuitem', { name: '另存为模板' }).click();
  const template = page.getByRole('dialog', { name: '另存为模板', exact: true });
  await template.getByRole('textbox', { name: '模板名称' }).fill('E2E 申请模板');
  await template.getByRole('button', { name: '另存为模板', exact: true }).click();
  await expect(template).toBeHidden();
  await open(page, '/#/apps');
  await page.getByRole('tab', { name: '模板', exact: true }).click();
  const tile = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: 'E2E 申请模板', exact: true }) });
  await tile.getByRole('button', { name: '查看模板结构' }).click();
  const structure = page.getByRole('dialog', { name: '模板结构' });
  await expect(structure.locator('pre')).toBeVisible();
  await structure.getByRole('button', { name: '审核通过' }).click();
  await expect(structure).toBeHidden();
  const installerContext = await browser.newContext({ storageState: as('mei') });
  const installer = await installerContext.newPage();
  await open(installer, '/#/apps');
  await installer.getByRole('tab', { name: '模板', exact: true }).click();
  await installer
    .locator('article')
    .filter({ has: installer.getByRole('heading', { name: 'E2E 申请模板', exact: true }) })
    .getByRole('button', { name: '从模板新建' })
    .click();
  await expect(installer).toHaveURL(/#\/apps\/app_.*\/edit/);
  const installedId = /#\/apps\/(app_[0-9A-Z]+)/.exec(installer.url())![1]!;
  const installed = await apiAs<AppDraft>(request, 'mei', 'GET', `/api/apps/${installedId}/draft`);
  expect(installed.app.base_id).not.toBe(base.id);
  expect(installed.audience).toEqual([]);
  await installerContext.close();
});

test('apps: rail, search, notifications, light/dark and narrow layouts', async ({ page, request }) => {
  const base = await apiAs<Base>(request, 'lin', 'POST', '/api/tables/bases', { name: 'E2E 应用导航' });
  const draft = await apiAs<AppDraft>(request, 'lin', 'POST', '/api/apps', { base_id: base.id, name: 'E2E 导航应用' });
  const saved = await apiAs<AppDraft>(request, 'lin', 'PUT', `/api/apps/${draft.app.id}/draft`, {
    revision: draft.revision,
    name: draft.app.name,
    description: '',
    spec: {
      pages: [
        {
          id: 'home',
          name: '首页',
          cards: [
            {
              id: 'count',
              kind: 'number',
              title: '记录数量',
              table_id: base.tables[0]!.id,
              measure: { aggregate: 'count' },
            },
          ],
        },
      ],
      roles: [],
    },
  });
  await apiAs(request, 'lin', 'POST', `/api/apps/${draft.app.id}/publish`, { revision: saved.revision, audience: [] });
  await open(page, `/#/apps/${draft.app.id}`);
  await expect(page.locator('.app-tb-dash-figure')).toHaveText('0');
  await expect(page.locator('.app-rail').getByRole('button', { name: '应用', exact: true })).toBeVisible();
  await page.keyboard.press('Meta+k');
  await page.getByRole('combobox', { name: '搜索' }).fill('E2E 导航应用');
  await expect(page.getByRole('option', { name: /E2E 导航应用/ })).toBeVisible();
  await page.keyboard.press('Escape');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), theme);
    await page.screenshot({ path: `test-results/apps-${theme}.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/apps-narrow.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
