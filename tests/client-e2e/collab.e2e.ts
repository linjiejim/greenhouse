import { test, expect, type Page } from '@playwright/test';
import { installCollab, collabShot, PRIVATE_DOC } from './collab-fixture';
import { DOC } from './p2-fixture';
import { PROJECT } from './p3-fixture';
const ready = async (page: Page, path: string) => {
  await page.goto(path);
  await expect(page.getByTestId('startup-splash')).toHaveCount(0);
};
const confirm = (page: Page, name: string) =>
  page.getByRole('dialog').last().getByRole('button', { name, exact: true }).click();

test('project members: a manager adds, re-roles and removes members in the dialog', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const f = await installCollab(page);
  await ready(page, '/projects');
  await page.getByRole('button', { name: '成员', exact: true }).click();
  const dialog = page.getByTestId('project-members');
  const list = dialog.getByTestId('project-members-list');
  await expect(list).toContainText('王宁');
  await expect(list).toContainText('林杰（我）');
  // owners first; the project's owner stays, my own row has no controls
  await expect(list.locator('tbody tr').first()).toContainText('王宁');
  await expect(dialog.getByRole('button', { name: '移除王宁' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '移除林杰' })).toHaveCount(0);
  // only people who are not members yet are offered
  const person = dialog.getByRole('combobox', { name: '成员', exact: true });
  await expect(person.locator('option')).toHaveText(['选择一位成员', '赵敏']);
  await person.selectOption('usr_zhao');
  await dialog.getByRole('combobox', { name: '角色', exact: true }).selectOption('owner');
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await expect(list).toContainText('赵敏');
  expect(f.writes.find((w) => w.method === 'POST')?.body).toEqual({ user_id: 'usr_zhao', role: 'owner' });
  await collabShot(page, 'project-members-1280');

  await dialog.getByRole('combobox', { name: '角色 · 钱多' }).selectOption('owner');
  await expect
    .poll(() => f.writes.find((w) => w.method === 'PATCH'))
    .toMatchObject({ path: `/api/projects/${PROJECT}/members/usr_qian`, body: { role: 'owner' } });
  await dialog.getByRole('button', { name: '移除钱多' }).click();
  await confirm(page, '移除');
  await expect(list).not.toContainText('钱多');
  expect(f.writes.at(-1)).toMatchObject({ method: 'DELETE', path: `/api/projects/${PROJECT}/members/usr_qian` });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('project members: others read the list', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await installCollab(page, { me: 'team' });
  await ready(page, '/projects');
  await page.getByRole('button', { name: '成员', exact: true }).click();
  const dialog = page.getByTestId('project-members');
  await expect(dialog.getByTestId('project-members-list')).toContainText('钱多');
  await expect(dialog).toContainText('只有项目负责人可以调整成员。');
  await expect(dialog.getByRole('combobox')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /^移除/ })).toHaveCount(0);
  await collabShot(page, 'project-members-read-only-1280');
});

test('project members: a refusal turns the panel read-only', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const f = await installCollab(page, { refuse: true });
  await ready(page, '/projects');
  await page.getByRole('button', { name: '成员', exact: true }).click();
  const dialog = page.getByTestId('project-members');
  await dialog.getByRole('combobox', { name: '成员', exact: true }).selectOption('usr_zhao');
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.getByRole('dialog').last()).toContainText('添加成员失败');
  await confirm(page, '好');
  await expect(dialog).toContainText('只有项目负责人可以调整成员。');
  await expect(dialog.getByRole('combobox')).toHaveCount(0);
  expect(f.writes).toHaveLength(1);
});

test('project members on a phone-width browser open from the project sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installCollab(page);
  await ready(page, `/sheet/project?id=${PROJECT}`);
  await page.getByRole('button', { name: '成员', exact: true }).click();
  const dialog = page.getByTestId('project-members');
  await expect(dialog.getByTestId('project-members-list')).toContainText('王宁');
  await collabShot(page, 'project-members-390');
});

test('document sharing: the owner shares a private document, changes access and stops sharing', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const f = await installCollab(page);
  // a team document is everyone's already: no share entry
  await ready(page, `/knowledge?doc=${DOC}`);
  await expect(page.getByTestId('knowledge-document')).toContainText('远程办公政策');
  await expect(page.getByRole('button', { name: '共享', exact: true })).toHaveCount(0);

  await ready(page, `/knowledge?shelf=personal&doc=${PRIVATE_DOC}`);
  await expect(page.getByTestId('knowledge-document')).toContainText('季度目标');
  await page.getByRole('button', { name: '共享', exact: true }).click();
  const dialog = page.getByTestId('doc-share');
  await expect(dialog).toContainText('共享「我的季度笔记」');
  const list = dialog.getByTestId('doc-share-list');
  await expect(list).toContainText('王宁');
  const person = dialog.getByRole('combobox', { name: '成员', exact: true });
  // everyone without a grant, by name (the order follows the browser's collation)
  await expect(person.locator('option')).toHaveCount(3);
  await expect(person).toContainText('钱多');
  await expect(person).toContainText('赵敏');
  await person.selectOption('usr_zhao');
  await dialog.getByRole('combobox', { name: '权限', exact: true }).selectOption('editor');
  await dialog.getByRole('button', { name: '共享', exact: true }).click();
  await expect(list).toContainText('赵敏');
  expect(f.writes[0]).toMatchObject({
    method: 'POST',
    path: `/api/knowledge/docs/${PRIVATE_DOC}/shares`,
    body: { user_ids: ['usr_zhao'], role: 'editor' },
  });
  await collabShot(page, 'doc-share-1280');

  await dialog.getByRole('combobox', { name: '权限 · 王宁' }).selectOption('editor');
  await expect.poll(() => f.writes[1]?.body).toEqual({ user_ids: ['usr_wang'], role: 'editor' });
  await dialog.getByRole('button', { name: '取消与王宁共享' }).click();
  await confirm(page, '取消共享');
  await expect(list).not.toContainText('王宁');
  expect(f.writes.at(-1)).toMatchObject({
    method: 'DELETE',
    path: `/api/knowledge/docs/${PRIVATE_DOC}/shares/usr_wang`,
  });
});

test('document sharing on a phone-width browser opens from the document sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installCollab(page);
  await ready(page, '/knowledge?shelf=personal');
  await page.getByText('我的季度笔记', { exact: true }).click();
  await expect(page.getByText('先写给自己看，再分享给同事。')).toBeVisible();
  await page.getByRole('button', { name: '共享', exact: true }).click();
  await expect(page.getByTestId('doc-share-list')).toContainText('王宁');
  await collabShot(page, 'doc-share-390');
});
