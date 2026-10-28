import { test, expect, type Page } from '@playwright/test';
import { installPlaces, PROJECT, TABLE } from './p3-fixture';

/** The sheet forms (FormChrome + NativeForm): desktop dialogs on a wide window, phone sheets when narrow. */
const ready = async (page: Page, path: string) => {
  // settle on the fixture's member first: forms bind to the account that opened them
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Jim Lin/ })).toBeVisible();
  await page.goto(path);
  await expect(page.getByTestId('startup-splash')).toHaveCount(0);
};

async function installForms(page: Page) {
  const f = await installPlaces(page);
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ json: body });
    if (url.pathname === `/api/tables/tables/${TABLE}/records` && route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      f.writes.push({ path: url.pathname, body, method: 'POST' });
      return json({ record: { id: '14', table_id: TABLE, values: body.values, computed_values: {} } });
    }
    if (url.pathname === '/api/projects/meta/users')
      return json({ users: [{ id: 'member', nickname: '林杰', role: 'super' }] });
    if (url.pathname === `/api/projects/${PROJECT}/tasks` && route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      f.writes.push({ path: url.pathname, body, method: 'POST' });
      return json({ task: { id: '23', project_id: PROJECT, status: 'todo', ...body } });
    }
    return route.fallback();
  });
  return f;
}

const sheet = (page: Page) => page.getByTestId('client-sheet').filter({ visible: true });

test('wide sheet forms are desktop dialogs: Cancel and the primary action trail the footer', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const f = await installForms(page);
  await ready(page, `/tables/new-record?table=${TABLE}`);
  const dialog = sheet(page);
  await expect(dialog.getByRole('heading', { name: '添加记录', exact: true })).toBeVisible();
  // the md dialog size (src/ui/overlay.web.tsx DIALOG_SIZES)
  expect((await dialog.boundingBox())?.width).toBe(560);
  const cancel = dialog.getByRole('button', { name: '取消', exact: true });
  const save = dialog.getByRole('button', { name: '保存', exact: true });
  await expect(save).toHaveClass(/gh-primary/);
  await expect(cancel).toHaveClass(/gh-secondary-button/);
  const [box, cancelBox, saveBox] = await Promise.all([dialog.boundingBox(), cancel.boundingBox(), save.boundingBox()]);
  expect(saveBox!.width).toBeLessThan(160);
  expect(cancelBox!.x + cancelBox!.width).toBeLessThan(saveBox!.x);
  expect(box!.x + box!.width - (saveBox!.x + saveBox!.width)).toBeLessThanOrEqual(24);
  // select fields read label-above-control, in the shared Controls
  await expect(dialog.getByRole('combobox', { name: '渠道', exact: true })).toHaveClass(/gh-input/);

  // Enter in a field submits
  await dialog.getByRole('textbox', { name: '客户', exact: true }).fill('Acme');
  await page.keyboard.press('Enter');
  await expect
    .poll(() => f.writes.find((w) => w.path === `/api/tables/tables/${TABLE}/records`)?.body.values)
    .toMatchObject({ 'f-customer': 'Acme' });
  await expect(sheet(page)).toHaveCount(0);
});

test('Esc on a wide form dialog asks before discarding edits, and closes a clean one', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const f = await installForms(page);
  await ready(page, `/task-form?project=${PROJECT}`);
  const dialog = sheet(page);
  await expect(dialog.getByRole('heading', { name: '新建任务', exact: true })).toBeVisible();
  await dialog.getByRole('textbox', { name: '标题', exact: true }).fill('写周报');
  await page.keyboard.press('Escape');
  const confirm = page.getByRole('dialog').filter({ hasText: '放弃更改？' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '标题', exact: true })).toHaveValue('写周报');
  await page.keyboard.press('Escape');
  await confirm.getByRole('button', { name: '放弃', exact: true }).click();
  await expect(sheet(page)).toHaveCount(0);
  expect(f.writes.some((w) => w.path === `/api/projects/${PROJECT}/tasks`)).toBe(false);

  // nothing typed: Esc closes without asking
  await ready(page, '/sheets/feedback');
  await expect(sheet(page).getByRole('heading', { name: '发送反馈', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByRole('dialog').filter({ hasText: '放弃更改？' })).toHaveCount(0);
});

test('narrow sheet forms keep the phone sheet: a full-width primary action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installForms(page);
  await ready(page, `/task-form?project=${PROJECT}`);
  const add = page.getByRole('button', { name: '添加', exact: true }).filter({ visible: true });
  await expect(add).toBeVisible();
  expect((await add.boundingBox())!.width).toBeGreaterThan(300);
  await expect(page.locator('.gh-dialog-footer')).toHaveCount(0);
});
