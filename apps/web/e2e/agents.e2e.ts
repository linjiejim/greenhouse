import { expect, test } from '@playwright/test';
import { composer, open } from './fixtures';

test('a new Agent from a template opens its own thread and gets a profile with versions', async ({ page }) => {
  await open(page, '/#/agents');
  await page.getByRole('button', { name: '新建 Agent' }).first().click();
  const drawer = page.getByRole('dialog', { name: '新建 Agent' });
  await drawer.getByRole('button', { name: /卷卷 · 写手/ }).click();
  await expect(drawer.getByLabel('名字')).toHaveValue('卷卷');
  await drawer.getByLabel('名字').fill('Scribe');
  await drawer.getByRole('button', { name: '创建 Agent' }).click();
  await expect(page).toHaveURL(/#\/c\/cnv_/);
  await expect(composer(page)).toHaveAttribute('placeholder', '给 Scribe 发消息');
  await expect(page.getByRole('complementary', { name: '目录' }).getByRole('link', { name: 'Scribe' })).toBeVisible();

  await composer(page).fill('draft a note');
  await composer(page).press('Enter');
  await expect(page.getByText('Echo: draft a note')).toBeVisible();

  await page.goto('/#/agents');
  await page.getByRole('link', { name: /Scribe/ }).click();
  await expect(page.getByRole('tab', { name: '资料' })).toHaveAttribute('aria-selected', 'true');
  await page.getByLabel('职责').fill('Editor');
  await page.getByLabel('这次改了什么').fill('New role');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('已保存为版本 2')).toBeVisible();
  await expect(page.getByText('New role')).toBeVisible();
});

test('memory: remember, edit and forget', async ({ page }) => {
  await open(page, '/#/agents/main?tab=memory');
  await page.getByRole('button', { name: '记住一件事' }).click();
  const dialog = page.getByRole('dialog', { name: '记住一件事' });
  await dialog.getByLabel('标题').fill('Prefers short answers');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('button', { name: /Prefers short answers/ })).toBeVisible();

  await page.getByRole('button', { name: /Prefers short answers/ }).click();
  const edit = page.getByRole('dialog', { name: '修改记忆' });
  await edit.getByLabel('标题').fill('Prefers very short answers');
  await edit.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('button', { name: /Prefers very short answers/ })).toBeVisible();

  await page.getByRole('button', { name: /Prefers very short answers/ }).click();
  await page.getByRole('dialog', { name: '修改记忆' }).getByRole('button', { name: '忘记' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '忘记' }).click();
  await expect(page.getByText('还没有记忆')).toBeVisible();
});

test('schedules: create, pause, run now and delete', async ({ page }) => {
  await open(page, '/#/agents/main?tab=schedules');
  await page.getByRole('button', { name: '新建定时' }).click();
  const dialog = page.getByRole('dialog', { name: '新建定时' });
  await dialog.getByLabel('名字').fill('Morning brief');
  await dialog.getByLabel('简报').fill('Summarize what is on today.');
  await dialog.getByRole('button', { name: '创建定时' }).click();
  const row = page.getByRole('listitem').filter({ hasText: 'Morning brief' });
  await expect(row).toContainText('每天 09:00');

  await row.getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: '暂停' }).click();
  await expect(row.getByText('已暂停')).toBeVisible();

  await row.getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: '立即运行' }).click();
  await expect(page.getByText('已开始「Morning brief」')).toBeVisible();

  await row.getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '删除' }).click();
  await expect(page.getByText('还没有定时')).toBeVisible();
});

test('archiving an Agent moves it to 已归档, and restoring brings it back', async ({ page }) => {
  await open(page, '/#/agents');
  await page.getByRole('button', { name: '新建 Agent' }).first().click();
  const drawer = page.getByRole('dialog', { name: '新建 Agent' });
  await drawer.getByRole('button', { name: /空白 Agent/ }).click();
  await drawer.getByLabel('名字').fill('Temp');
  await drawer.getByRole('button', { name: '创建 Agent' }).click();
  await expect(page).toHaveURL(/#\/c\/cnv_/);

  await page.goto('/#/agents');
  await page.getByRole('link', { name: /Temp/ }).click();
  await page.getByRole('main').getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: '归档' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '归档' }).click();
  await expect(page.getByText('这个 Agent 已归档，恢复后才能对话。')).toBeVisible();

  await page.goto('/#/agents?scope=archived');
  await expect(page.getByRole('link', { name: /Temp/ })).toBeVisible();
  await page.getByRole('link', { name: /Temp/ }).click();
  await page.getByRole('main').getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: '恢复' }).click();
  await expect(page.getByText('已恢复「Temp」')).toBeVisible();
});

test("the Agent's model: a picker when there is more than one, saved as a new version", async ({ page }) => {
  await open(page, '/#/agents/main?tab=abilities');
  const picker = page.getByRole('combobox', { name: '模型' });
  await expect(picker).toContainText('工作区默认');
  await picker.click();
  await page.getByRole('option', { name: /fake-strong/ }).click();
  await expect(picker).toContainText('fake-strong');
  await page.getByRole('tab', { name: '资料' }).click();
  await page.getByRole('tab', { name: '能力' }).click();
  await expect(page.getByRole('combobox', { name: '模型' })).toContainText('fake-strong');
});
