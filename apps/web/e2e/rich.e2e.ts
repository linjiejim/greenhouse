import { expect, test, type Page } from '@playwright/test';
import { composer, open } from './fixtures';

async function ask(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

test.beforeEach(async ({ page }) => {
  await open(page, '/#/c/new');
  await ask(page, 'hello rich');
  await expect(page).toHaveURL(/#\/c\/cnv_/);
});

test('charts, tables and stats render as blocks, never as raw JSON', async ({ page }) => {
  await ask(page, 'show chart');
  await expect(page.getByRole('img', { name: 'Sales' })).toBeVisible();
  await ask(page, 'show table');
  await expect(page.getByRole('cell', { name: 'Build' })).toBeVisible();
  await expect(page.getByRole('button', { name: '导出 CSV' })).toBeVisible();
  await ask(page, 'show stats');
  await expect(page.getByText('128')).toBeVisible();
  await expect(page.getByText('"datasets"')).toHaveCount(0);
});

test('a choice block sends the pressed value as my message, then shows what was chosen', async ({ page }) => {
  await ask(page, 'show choices');
  await page.getByRole('button', { name: 'Plan A' }).click();
  await expect(page.locator('.app-message.is-mine').last()).toContainText('go with plan A');
  await expect(page.getByRole('button', { name: 'Plan A' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Plan B' })).toBeDisabled();
});

test('a Mermaid diagram draws, and a page preview can fill the composer', async ({ page }) => {
  await ask(page, 'show diagram');
  await expect(page.locator('.app-mermaid svg')).toBeVisible({ timeout: 15_000 });
  await ask(page, 'show page');
  await page.getByRole('button', { name: '预览' }).click();
  const frame = page.frameLocator('iframe[title="Picker"]');
  await frame.getByRole('button', { name: 'Send' }).click();
  await expect(composer(page)).toHaveValue('from the page');
});
