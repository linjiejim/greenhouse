import { expect, test, type Page } from '@playwright/test';
import { as, composer, open } from './fixtures';

const lastReply = (page: Page) => page.locator('.app-message.is-reply').last();

test('rate a reply, and the rating is still there after a reload', async ({ page }) => {
  await open(page);
  await composer(page).fill('rate this');
  await composer(page).press('Enter');
  await expect(page.getByText('Echo: rate this')).toBeVisible();
  const reply = lastReply(page);
  await reply.hover();
  await reply.getByRole('button', { name: '有帮助' }).click();
  await expect(reply.getByRole('button', { name: '有帮助' })).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(lastReply(page).getByRole('button', { name: '有帮助' })).toHaveAttribute('aria-pressed', 'true');
});

test('edit my last message: the old reply goes and it is answered again; regenerate writes it again', async ({
  page,
}) => {
  await open(page, '/#/c/new');
  await composer(page).fill('first wording');
  await composer(page).press('Enter');
  await expect(page.getByText('Echo: first wording')).toBeVisible();

  const mine = page.locator('.app-message.is-mine').last();
  await mine.hover();
  await mine.getByRole('button', { name: '编辑' }).click();
  const editor = page.getByRole('textbox', { name: '编辑' });
  await editor.fill('second wording');
  await page.getByRole('button', { name: '保存并重新回答' }).click();
  await expect(page.getByText('Echo: second wording')).toBeVisible();
  await expect(page.getByText('Echo: first wording')).toHaveCount(0);
  await expect(page.locator('.app-message.is-mine').last()).toContainText('已编辑');

  const reply = lastReply(page);
  await reply.hover();
  await reply.getByRole('button', { name: '重新生成' }).click();
  await expect(page.getByText('Echo: second wording')).toHaveCount(1);
  await expect(page.locator('.app-message.is-reply')).toHaveCount(1);
});

test('export a chat as Markdown', async ({ page }) => {
  await open(page, '/#/c/new');
  await composer(page).fill('export me');
  await composer(page).press('Enter');
  await expect(page.getByText('Echo: export me')).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: '更多' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: '导出 Markdown' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.md$/);
  const text = await (await file.createReadStream()).toArray();
  expect(Buffer.concat(text).toString('utf8')).toContain('Echo: export me');
});

test('a room: Lin brings Mei and Greeny, Mei writes back, notes are shared, Mei leaves', async ({ page, browser }) => {
  await open(page);
  await page.getByRole('complementary', { name: '目录' }).getByRole('button', { name: '新房间' }).click();
  const dialog = page.getByRole('dialog', { name: '新房间' });
  await dialog.getByLabel('房间名').fill('Launch');
  await dialog.getByRole('combobox', { name: '添加的人' }).click();
  await page.getByRole('option', { name: /Mei/ }).click();
  await dialog.getByRole('combobox', { name: '带上我的 Agent' }).click();
  await page.getByRole('option', { name: /Greeny/ }).click();
  await dialog.getByRole('button', { name: '创建房间' }).click();
  await expect(page).toHaveURL(/#\/c\/cnv_/);
  await expect(page.getByRole('main').getByText('Launch')).toBeVisible();

  await composer(page).fill('@');
  await page.getByRole('option', { name: /Greeny/ }).click();
  await composer(page).pressSequentially('hello room');
  await composer(page).press('Enter');
  await expect(page.getByText(/Echo: .*hello room/)).toBeVisible();

  await page.getByRole('button', { name: '信息' }).click();
  const info = page.getByRole('dialog', { name: '信息' });
  await expect(info.getByText('Mei')).toBeVisible();
  await info.getByLabel('标题').fill('Ship on Friday');
  await info.getByRole('button', { name: '添加笔记' }).click();
  await expect(info.getByText('Ship on Friday')).toBeVisible();
  await info.getByRole('button', { name: '关闭' }).click();
  const roomUrl = page.url();

  const mei = await browser.newContext({ storageState: as('mei'), locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const other = await mei.newPage();
  await other.goto(roomUrl);
  await expect(other.getByText('@Greeny hello room', { exact: true })).toBeVisible();
  await other.getByRole('button', { name: '信息' }).click();
  await expect(other.getByRole('dialog', { name: '信息' }).getByText('Ship on Friday')).toBeVisible();
  await other.getByRole('dialog', { name: '信息' }).getByRole('button', { name: '关闭' }).click();
  await composer(other).fill('Mei here');
  await composer(other).press('Enter');
  await expect(page.getByText('Mei here')).toBeVisible();

  await other.getByRole('main').getByRole('button', { name: '更多' }).click();
  await other.getByRole('menuitem', { name: '离开房间' }).click();
  await other.getByRole('alertdialog').getByRole('button', { name: '离开房间' }).click();
  await expect(other).toHaveURL(/#\/c\/main$/);
  await mei.close();
});

test('⌘K finds words inside messages', async ({ page }) => {
  await open(page);
  await composer(page).fill('zebra crossing plans');
  await composer(page).press('Enter');
  await expect(page.getByText('Echo: zebra crossing plans')).toBeVisible();
  await page.goto('/#/agents');
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox').fill('zebra');
  const hit = page.getByRole('option', { name: /zebra crossing plans/ }).first();
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page).toHaveURL(/#\/c\//);
  await expect(page.getByText('Echo: zebra crossing plans')).toBeVisible();
});
