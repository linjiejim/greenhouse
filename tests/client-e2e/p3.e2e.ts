import { test, expect } from '@playwright/test';
import { installPlaces, FILE, TASK, AUTO } from './p3-fixture';
import { shot } from './p2-fixture';
const ready = async (page: import('@playwright/test').Page, path: string) => {
  await page.goto(path);
  await expect(page.getByTestId('startup-splash')).toHaveCount(0);
};
test('P3 knowledge tree, Tiptap Markdown save, keyboard and dark document', async ({ page }) => {
  const f = await installPlaces(page);
  await ready(page, '/knowledge');
  await expect(page.getByTestId('knowledge-document')).toContainText('远程办公政策');
  const sidebar = page.getByTestId('client-secondary');
  await expect(sidebar.getByRole('button', { name: '人事制度' })).toBeVisible();
  await sidebar.getByRole('button', { name: '远程办公政策', exact: true }).last().focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'editor', exact: true });
  await expect(editor).toBeVisible();
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
  await page.getByRole('row', { name: /Wayne Enterprises/ }).click();
  await expect(page.getByTestId('client-inspector').filter({ visible: true })).toContainText('Wayne Enterprises');
});
test('P3 project board drag, list, gantt and task inspector', async ({ page }) => {
  const f = await installPlaces(page);
  await ready(page, '/projects');
  const card = page.getByTestId('project-kanban').locator('.gh-task-card').filter({ hasText: '定价页文案' });
  await card.dragTo(page.locator('[data-status="done"]'));
  await expect
    .poll(() => f.writes.some((w) => w.path === `/api/projects/tasks/${TASK}` && w.body?.status === 'done'))
    .toBeTruthy();
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
      await shot(page, design, width);
    }
    await ready(page, '/knowledge');
    await page.evaluate(() => localStorage.setItem('greenhouse_pref_theme', 'dark'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await shot(page, '13', width);
    await page.keyboard.press('Meta+,');
    if (width >= 760) await expect(page.getByTestId('settings-overlay')).toBeVisible();
    else await expect(page.getByRole('button', { name: '关闭', exact: true }).first()).toBeVisible();
    await shot(page, '10', width);
  });
