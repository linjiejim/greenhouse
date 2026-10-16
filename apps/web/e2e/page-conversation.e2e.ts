import { expect, test } from '@playwright/test';
import { apiAs } from './api';
import { open } from './fixtures';

test('⌘J saves a page conversation, reopens it, and works as a narrow sheet', async ({ page, request }) => {
  const doc = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/knowledge/docs', {
    title: 'Page context',
    content: 'A page note',
    space: 'personal',
  });
  await open(page, `/#/knowledge/${doc.id}`);
  await page.keyboard.press('Control+j');
  const panel = page.getByRole('dialog', { name: '页面助手' });
  await expect(panel.getByRole('textbox', { name: /发消息/ })).toBeVisible();
  await panel.getByRole('textbox', { name: /发消息/ }).fill('about this page');
  await panel.getByRole('textbox', { name: /发消息/ }).press('Enter');
  await expect(panel.getByText('Echo: about this page', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '关闭详情', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await page.keyboard.press('Control+j');
  await expect(panel.getByText('Echo: about this page', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('textbox', { name: /发消息/ })).toBeInViewport({ ratio: 1 });
  await panel.getByRole('button', { name: '打开会话' }).click();
  await expect(page).toHaveURL(/#\/c\/cnv_/);
  await expect(page.getByText('Echo: about this page', { exact: true })).toBeVisible();
});
