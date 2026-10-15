import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { composer, messageMenu, open } from './fixtures';

const pictures = new URL('../../../artifacts/u1/after/interactions/', import.meta.url).pathname;
mkdirSync(pictures, { recursive: true });

test('small questions answer inline once, show the optimistic pick, and retain it after reload', async ({ page }) => {
  await open(page, '/#/c/new');
  await composer(page).fill('ask me choices');
  await composer(page).press('Enter');
  const card = page.locator('.gh-chat-card', { hasText: 'Which city?' });
  const osaka = card.getByRole('button', { name: 'Osaka', exact: true });
  await expect(osaka).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  await page.route('**/api/requests/*/answer', async (route) => {
    count += 1;
    expect(route.request().postDataJSON()).toEqual({ answers: { city: 'Osaka' } });
    await gate;
    await route.continue();
  });
  await osaka.click();
  await expect(osaka).toHaveAttribute('aria-pressed', 'true');
  await expect(osaka).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Kyoto', exact: true })).toBeDisabled();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  release();
  await expect(card.getByText('已完成', { exact: true })).toBeVisible();
  expect(count).toBe(1);
  await page.reload();
  await expect(osaka).toHaveAttribute('aria-pressed', 'true');
  await expect(osaka).toBeDisabled();
  await page.screenshot({ path: `${pictures}inline-selected.png` });
});

test('a failed inline answer restores the options and offers a direct retry', async ({ page }) => {
  await open(page, '/#/c/new');
  await composer(page).fill('ask me choices');
  await composer(page).press('Enter');
  const card = page.locator('.gh-chat-card', { hasText: 'Which city?' });
  await page.route('**/api/requests/*/answer', (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: 'unavailable', message: 'Unavailable' } },
    }),
  );
  const button = card.getByRole('button', { name: 'Kyoto', exact: true });
  await button.click();
  await expect(card.getByRole('alert')).toBeVisible();
  await expect(button).toBeEnabled();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await page.unroute('**/api/requests/*/answer');
  await button.click();
  await expect(card.getByText('已完成', { exact: true })).toBeVisible();
});

test('input questions keep a simple guarded drawer, a fixed footer and a scrim over the whole shell', async ({
  page,
}) => {
  await open(page, '/#/c/new');
  await composer(page).fill('ask me where');
  await composer(page).press('Enter');
  await page.locator('.gh-chat-card', { hasText: 'Which city?' }).getByRole('button', { name: '提交回答' }).click();
  const dialog = page.getByRole('dialog', { name: 'Which city?' });
  await expect(dialog).toBeVisible();
  expect(
    await page.locator('.gh-scrim').evaluate((scrim) => {
      const rect = scrim.getBoundingClientRect();
      return rect.left === 0 && rect.width === innerWidth && document.elementFromPoint(20, 30) === scrim;
    }),
  ).toBe(true);
  await dialog.getByLabel('City').fill('Hangzhou');
  await dialog.getByRole('button', { name: '关闭详情' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '继续编辑' }).click();
  await expect(dialog.getByLabel('City')).toHaveValue('Hangzhou');
  for (const [theme, width] of [
    ['light', 1440],
    ['dark', 1440],
    ['light', 390],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await dialog.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    const footer = dialog.locator('.gh-overlay-footer');
    const before = await footer.boundingBox();
    await dialog.locator('.gh-overlay-body').evaluate((body) => {
      body.scrollTop = body.scrollHeight;
    });
    expect((await footer.boundingBox())?.y).toBe(before?.y);
    await page.screenshot({ path: `${pictures}question-drawer-${theme}-${width}.png` });
  }
  await dialog.getByRole('button', { name: '提交回答' }).click();
  await expect(dialog).toHaveCount(0);
});

test('replies use full width without repeated identity, calm prose, and one keyboard-accessible action menu', async ({
  page,
}) => {
  await open(page, '/#/c/new');
  await composer(page).fill('# A heading\n\n**A point** and `code`\n\n- one\n- two');
  await composer(page).press('Enter');
  const reply = page.locator('.app-message.is-reply').last();
  await expect(reply.getByRole('button', { name: '消息操作' })).toBeAttached();
  await expect(reply.locator('.app-message-author')).toHaveCount(0);
  const prose = reply.locator('.is-reply-text');
  await expect(prose.locator('strong')).toHaveCSS('font-weight', '500');
  await expect(prose.locator('code')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const trigger = reply.getByRole('button', { name: '消息操作' });
  await trigger.focus();
  await trigger.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: '复制', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect((await messageMenu(reply)).getByRole('menuitem', { name: '重新生成' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(reply).toHaveCSS('animation-duration', '0s');
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({ path: `${pictures}calm-reply-390.png` });
});
