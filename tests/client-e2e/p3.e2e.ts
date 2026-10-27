import { test, expect } from '@playwright/test';
import { installPlaces, FILE, TASK, PROJECT, AUTO } from './p3-fixture';
import { shot } from './p2-fixture';
const ready = async (page: import('@playwright/test').Page, path: string) => {
  await page.goto(path);
  await expect(page.getByTestId('startup-splash')).toHaveCount(0);
};
test('P3 knowledge tree, Tiptap Markdown save, keyboard and dark document', async ({ page }) => {
  const f = await installPlaces(page);
  await ready(page, '/knowledge');
  await expect(page.getByTestId('knowledge-document')).toContainText('远程办公政策');
  await expect(page.getByRole('heading', { name: '在哪里工作', exact: true })).toHaveCSS('font-size', '20px');
  await expect(page.locator('.gh-doc-meta')).toContainText('林杰');
  const sidebar = page.getByTestId('client-secondary');
  await expect(sidebar.getByRole('button', { name: '人事制度' })).toBeVisible();
  await sidebar.getByRole('button', { name: '远程办公政策', exact: true }).last().focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'editor', exact: true });
  await expect(editor).toBeVisible();
  await expect(editor.locator('h2').first()).toHaveCSS('font-size', '20px');
  await expect(editor).toHaveCSS('line-height', '28px');
  await editor.fill('这是新政策内容');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByTestId('knowledge-document')).toContainText('这是新政策内容');
  expect(
    f.writes.find((w) => w.path.includes('/knowledge/docs/') && w.method === 'PUT')?.body.content_markdown,
  ).toContain('这是新政策内容');
});
test('P3 drive preview, rename, move, delete and dropped upload', async ({ page }) => {
  const f = await installPlaces(page);
  await ready(page, '/drive');
  const row = page.getByTestId('drive-list').getByRole('button', { name: 'Q4 活动方案.docx', exact: true });
  await row.click();
  await expect(page.getByTestId('client-inspector').filter({ visible: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await page.getByRole('dialog').locator('input').fill('新活动方案.docx');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /好|确定|保存/ })
    .click();
  await expect(page.getByRole('button', { name: '新活动方案.docx', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新活动方案.docx', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移动', exact: true }).click();
  await expect(page.getByTestId('client-sheet').filter({ visible: true })).toBeVisible();
  await page.getByRole('button', { name: '人事制度', exact: true }).last().click();
  await page.getByRole('button', { name: '移到这里', exact: true }).click();
  await expect
    .poll(() => f.writes.some((w) => w.path === `/api/drive/files/${FILE}` && w.body?.folder_id === 'folder-hr'))
    .toBeTruthy();
  const transfer = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File(['draft'], 'upload.txt', { type: 'text/plain' }));
    return d;
  });
  await page.getByTestId('drive-list').dispatchEvent('drop', { dataTransfer: transfer });
  await expect.poll(() => f.writes.some((w) => w.path === '/api/drive/files/init')).toBeTruthy();
  await page.getByRole('button', { name: '新活动方案.docx', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
  await expect
    .poll(() => f.writes.some((w) => w.path === `/api/drive/files/${FILE}` && w.method === 'DELETE'))
    .toBeTruthy();
});
test('P3 tables grid opens a record in inspector', async ({ page }) => {
  await installPlaces(page);
  await ready(page, '/drive?view=tables');
  await page.getByRole('tab', { name: '按渠道', exact: true }).click();
  const row = page.getByRole('row', { name: /Wayne Enterprises/ });
  await row.click();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('client-inspector').filter({ visible: true })).toContainText('Wayne Enterprises');
});
test('P3 tables owner deletes a table from the sidebar menu after confirming', async ({ page }) => {
  const f = await installPlaces(page);
  await ready(page, '/drive?view=tables');
  const sidebar = page.getByTestId('client-secondary');
  await sidebar.getByRole('button', { name: '反馈', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除表', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('删除「反馈」？');
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
  await expect
    .poll(() => f.writes.some((w) => w.path === '/api/tables/tables/12/archive' && w.method === 'POST'))
    .toBeTruthy();
  await expect(sidebar.getByRole('button', { name: '反馈', exact: true })).toHaveCount(0);
});
test('P3 project board drag, list, gantt and task inspector', async ({ page }) => {
  const f = await installPlaces(page);
  await ready(page, '/projects');
  const card = page.getByTestId('project-kanban').locator('.gh-task-card').filter({ hasText: '定价页文案' });
  await card.getByRole('button', { name: '定价页文案', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`project=${PROJECT}`));
  await expect(page.getByTestId('client-inspector').filter({ visible: true })).toContainText('三档价格对比表 + FAQ');
  await page.keyboard.press('Escape');
  const done = page.getByRole('region', { name: '已完成', exact: true });
  await card.dragTo(done);
  await expect
    .poll(() => f.writes.some((w) => w.path === `/api/projects/tasks/${TASK}` && w.body?.status === 'done'))
    .toBeTruthy();
  await expect(done.getByRole('button', { name: '定价页文案', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '列表', exact: true }).click();
  await page
    .getByRole('button', { name: /定价页文案/ })
    .first()
    .click();
  await expect(page.getByTestId('client-inspector').filter({ visible: true })).toContainText('定价页文案');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: '甘特', exact: true }).click();
  await expect(page.getByTestId('project-gantt')).toBeVisible();
});
test('P3 automation pause, resume, run and history conversation', async ({ page }) => {
  const f = await installPlaces(page);
  await ready(page, '/automations');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect.poll(() => f.automation.enabled).toBe(false);
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  await expect.poll(() => f.automation.enabled).toBe(true);
  await page.getByRole('button', { name: '立即运行', exact: true }).click();
  await expect(page).toHaveURL(/session=policy-chat/);
  expect(f.writes.some((w) => w.path === `/api/tasks/${AUTO}/run`)).toBeTruthy();
  await ready(page, '/automations');
  await page.getByRole('button', { name: /4 个项目 · 2 个卡点/ }).click();
  await expect(page).toHaveURL(/session=policy-chat/);
});
for (const width of [1440, 1280, 1024, 390])
  test(`P3 design 03–07,10,13 at ${width}`, async ({ page }) => {
    await installPlaces(page);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const [design, path] of [
      ['03', '/knowledge'],
      ['04', '/drive?shelf=team'],
      ['05', '/drive?view=tables'],
      ['06', '/projects'],
      ['07', '/automations'],
    ]) {
      await ready(page, path);
      if (width >= 760) {
        if (design === '03') await expect(page.getByTestId('knowledge-document')).toContainText('远程办公政策');
        if (design === '04') {
          await page.getByRole('button', { name: 'Q4 活动方案.docx', exact: true }).click();
          await expect(page.getByTestId('client-inspector').filter({ visible: true })).toBeVisible();
        }
        if (design === '05') await expect(page.getByTestId('tables-grid')).toContainText('Wayne Enterprises');
        if (design === '06') {
          await page.getByRole('button', { name: '定价页文案', exact: true }).click();
          await expect(page.getByTestId('client-inspector').filter({ visible: true })).toBeVisible();
        }
      }
      await shot(page, `c4-${design}`, width);
    }
    await ready(page, '/knowledge');
    await page.evaluate(() => localStorage.setItem('greenhouse_pref_theme', 'dark'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByTestId('startup-splash')).toHaveCount(0);
    if (width >= 760) await expect(page.getByTestId('knowledge-document')).toContainText('远程办公政策');
    await shot(page, 'c4-13', width);
    if (width >= 760) {
      for (const [design, path] of [
        ['05-dark', '/drive?view=tables'],
        ['06-dark', '/projects'],
      ]) {
        await ready(page, path);
        if (design === '05-dark') await page.getByRole('row', { name: /Wayne Enterprises/ }).click();
        else await page.getByRole('button', { name: '定价页文案', exact: true }).click();
        await expect(page.getByTestId('client-inspector').filter({ visible: true })).not.toContainText(
          '这个任务不可用',
        );
        await shot(page, `c4-${design}`, width);
        await page.keyboard.press('Escape');
      }
      await ready(page, '/knowledge');
    }
    await page.keyboard.press('Meta+,');
    if (width >= 760) await expect(page.getByTestId('settings-overlay')).toBeVisible();
    else await expect(page.getByRole('button', { name: '关闭', exact: true }).first()).toBeVisible();
    await shot(page, 'c4-10', width);
  });
