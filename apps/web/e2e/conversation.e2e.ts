import { expect, test } from '@playwright/test';
import { composer, open, sendForRequest } from './fixtures';
import { apiAs } from './api';

test('a message streams a reply, and the thread keeps its order', async ({ page }) => {
  await open(page);
  await composer(page).fill('hello there');
  await composer(page).press('Enter');
  await expect(page.getByText('Echo: hello there')).toBeVisible();
  await expect(composer(page)).toHaveValue('');
  const bubbles = page.locator('.app-message');
  await expect(bubbles.last()).toContainText('Echo: hello there');
});

test('stop ends a long reply; a message sent meanwhile is queued and answered after', async ({ page }) => {
  await open(page);
  await composer(page).fill('slow one');
  await composer(page).press('Enter');
  await expect(page.getByText('Thinking about it slowly.')).toBeVisible();
  await composer(page).fill('second question');
  await composer(page).press('Enter');
  await expect(page.getByText('已排队，会在这一轮之后回答')).toBeVisible();
  await expect(page.getByText('Echo: second question')).toBeVisible({ timeout: 20_000 });

  await composer(page).fill('slow again');
  await composer(page).press('Enter');
  // The second slow reply is streaming (the first one's text is on the page too).
  await expect(page.getByText('Thinking about it slowly.')).toHaveCount(2);
  await page.getByRole('button', { name: '停止' }).click();
  await expect(page.getByText('已停止')).toBeVisible();
  await expect(page.getByRole('button', { name: '发送' })).toBeVisible();
});

test('a question card: answering it lets the Agent go on', async ({ page, request }) => {
  const thread = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/conversations', { kind: 'chat' });
  await open(page, `/#/c/${thread.id}`);
  await sendForRequest(page, thread.id, 'ask me where to go');
  const card = page.locator('.gh-chat-card', { hasText: 'Which city?' });
  await expect(card.getByText('需要你')).toBeVisible();
  await expect(page.locator('.app-rail-dot').first()).toBeVisible();
  await card.getByRole('button', { name: '提交回答' }).click();
  const form = page.getByRole('dialog', { name: 'Which city?' });
  await form.getByLabel('City').fill('Hangzhou');
  await form.getByRole('button', { name: '提交回答' }).click();
  await expect(card.getByText('已完成')).toBeVisible();
  await expect(page.getByText('已回答：Which city?')).toBeVisible();
  await expect(page.getByText('Done.')).toBeVisible();
});

test('a new chat becomes a conversation on its first message, and can be renamed and deleted', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '新会话' }).click();
  await expect(page).toHaveURL(/#\/c\/new$/);
  await expect(page.getByText('你好，Lin')).toBeVisible();
  await page.getByRole('listitem').filter({ hasText: '你能帮我做什么？' }).click();
  await expect(composer(page)).toHaveValue('你能帮我做什么？');
  await composer(page).fill('plan a picnic');
  await composer(page).press('Enter');
  await expect(page).toHaveURL(/#\/c\/cnv_/);
  await expect(page.getByText('Echo: plan a picnic')).toBeVisible();

  // Every chat the fake model names is "E2E chat": find this one by its address.
  const id = new URL(page.url()).hash.replace('#/c/', '');
  const row = page.getByRole('complementary', { name: '目录' }).locator(`a[href="#/c/${id}"]`);
  await expect(row).toContainText('E2E chat');
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重命名' }).click();
  const input = page.getByRole('textbox', { name: '重命名' });
  await input.fill('Picnic');
  await input.press('Enter');
  const renamed = page.getByRole('complementary', { name: '目录' }).locator(`a[href="#/c/${id}"]`);
  await expect(renamed).toContainText('Picnic');

  await renamed.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '删除' }).click();
  await expect(renamed).toHaveCount(0);
});

test('archive a chat, find it under 已归档, and bring it back', async ({ page }) => {
  await open(page, '/#/c/new');
  await composer(page).fill('archive me');
  await composer(page).press('Enter');
  await expect(page).toHaveURL(/#\/c\/cnv_/);
  const id = new URL(page.url()).hash.replace('#/c/', '');
  const directory = page.getByRole('complementary', { name: '目录' });
  const row = directory.locator(`a[href="#/c/${id}"]`);
  await expect(row).toBeVisible();
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '归档' }).click();
  await expect(page.getByText(/已归档「/)).toBeVisible();
  await expect(row).toHaveCount(0);

  await directory.getByRole('button', { name: '已归档' }).click();
  const archived = directory.locator(`a[href="#/c/${id}"]`);
  await expect(archived).toBeVisible();
  await archived.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '取消归档' }).click();
  await directory.getByRole('button', { name: '已归档' }).click();
  await expect(directory.locator(`a[href="#/c/${id}"]`)).toBeVisible();
});

test("a chat's own model: picked in 「⋯」 → 这个会话的模型, and kept", async ({ page }) => {
  await open(page, '/#/c/new');
  await composer(page).fill('pick a model');
  await composer(page).press('Enter');
  await expect(page).toHaveURL(/#\/c\/cnv_/);
  const main = page.getByRole('main');
  await main.getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: '这个会话的模型' }).click();
  const dialog = page.getByRole('dialog', { name: '这个会话的模型' });
  await expect(dialog.getByRole('combobox', { name: '这个会话的模型' })).toContainText('跟随 Agent');
  await dialog.getByRole('combobox', { name: '这个会话的模型' }).click();
  await page.getByRole('option', { name: /fake-strong/ }).click();
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();

  await main.getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: '这个会话的模型' }).click();
  await expect(page.getByRole('dialog', { name: '这个会话的模型' }).getByRole('combobox')).toContainText('fake-strong');
});

test('a reply lists its sources; one opens in the drawer and can be quoted', async ({ page }) => {
  await open(page, '/#/c/new');
  await composer(page).fill('search the web for kyoto');
  await composer(page).press('Enter');
  await expect(page.getByText('Found it:')).toBeVisible();
  // Only the result the reply links to is a source.
  await expect(page.getByRole('button', { name: '查看来源：Osaka food' })).toHaveCount(0);
  await page.getByRole('button', { name: '查看来源：Kyoto guide' }).click();
  const drawer = page.getByRole('dialog', { name: 'Kyoto guide' });
  await expect(drawer.getByText('https://kyoto.example/guide')).toBeVisible();
  await drawer.getByRole('button', { name: '就此追问' }).click();
  await expect(drawer).toBeHidden();
  await expect(page.locator('.app-chip.is-quote')).toContainText('Kyoto guide — https://kyoto.example/guide');
});
