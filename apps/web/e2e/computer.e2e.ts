import { expect, test, type Page } from '@playwright/test';
import { composer, open } from './fixtures';

/**
 * Computers are on in these tests, but their image cannot be pulled, so none ever starts: what
 * is tested is the Agent's page and the take-over card, not the screen itself (the API's live
 * tests cover that against the real image).
 */

/** A new chat whose Agent asks the member to take over its computer. */
async function askForTakeOver(page: Page) {
  await open(page);
  await page.getByRole('button', { name: '新会话' }).click();
  // Typed before the new chat replaces the main thread, the text would go to the old composer.
  await expect(page.getByText('你好，Lin')).toBeVisible();
  await composer(page).fill('need a human at the sign-in page');
  await composer(page).press('Enter');
  await expect(page).toHaveURL(/#\/c\/cnv_/);
  const card = page.locator('.gh-chat-card', { hasText: '需要你接管电脑' });
  await expect(card.getByText('需要你', { exact: true })).toBeVisible();
  await expect(card.getByText('Solve the human check on the sign-in page')).toBeVisible();
  return card;
}

test('a take-over card opens the screen in control, and handing back with a note wakes the Agent', async ({ page }) => {
  const card = await askForTakeOver(page);
  await card.getByRole('button', { name: '接管电脑' }).click();
  const drawer = page.getByRole('dialog', { name: 'Greeny 需要你接管电脑' });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('textbox', { name: '给 Agent 留句话（可选）' }).fill('Signed in for you');
  await drawer.getByRole('button', { name: '交还电脑' }).click();
  await expect(drawer).toBeHidden();
  await expect(card.getByText('已交还', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: '接管电脑' })).toBeHidden();
  await expect(page.getByText('Done.')).toBeVisible();
});

test('a take-over card can be handed back without taking over', async ({ page }) => {
  const card = await askForTakeOver(page);
  await card.getByRole('button', { name: '交还电脑' }).click();
  const dialog = page.getByRole('dialog', { name: '交还电脑' });
  await dialog.getByRole('button', { name: '交还电脑' }).click();
  await expect(card.getByText('已交还', { exact: true })).toBeVisible();
  await expect(page.getByText('Done.')).toBeVisible();
});

test("the Agent's page shows its computer, and why it could not start", async ({ page }) => {
  await open(page, '/#/agents/main?tab=computer');
  await expect(page.getByRole('tab', { name: '电脑' })).toHaveAttribute('aria-selected', 'true');
  // Taking over above tried to start it, and the image is not there.
  await expect(page.getByText('失败', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开机' })).toBeVisible();
  await expect(page.getByText('电脑没开机')).toBeVisible();
});

test("a conversation's computer drawer is the Agent's whole computer page", async ({ page }) => {
  await open(page);
  await page.getByRole('main').getByRole('button', { name: '电脑' }).click();
  const drawer = page.getByRole('dialog', { name: 'Greeny 的电脑' });
  await expect(drawer.getByRole('button', { name: '开机' })).toBeVisible();
  await expect(drawer.getByText('电脑没开机')).toBeVisible();
});
