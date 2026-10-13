import { expect, test } from '@playwright/test';
import { composer, open } from './fixtures';

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
  await expect(page.getByText('Thinking about it slowly.').last()).toBeVisible();
  await page.getByRole('button', { name: '停止' }).click();
  await expect(page.getByText('已停止')).toBeVisible();
  await expect(page.getByRole('button', { name: '发送' })).toBeVisible();
});

test('a question card: answering it lets the Agent go on', async ({ page }) => {
  await open(page);
  await composer(page).fill('ask me where to go');
  await composer(page).press('Enter');
  const card = page.locator('.gh-chat-card', { hasText: 'Which city?' });
  await expect(card.getByText('需要你')).toBeVisible();
  await expect(page.getByRole('button', { name: /需要你/ }).or(page.locator('.app-rail-count'))).toBeVisible();
  await card.getByLabel('City').fill('Hangzhou');
  await card.getByRole('button', { name: '提交回答' }).click();
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
