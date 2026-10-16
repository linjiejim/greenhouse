import { expect, test } from '@playwright/test';
import { composer, open } from './fixtures';
import { apiAs } from './api';

test('the header reflects a streaming reply, while one-to-one replies keep no avatar row', async ({
  page,
  request,
}) => {
  const thread = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/conversations', { kind: 'chat' });
  await open(page, `/#/c/${thread.id}`);
  // Observe the state synchronously as it changes; fast completions still count.
  await page.evaluate(() => {
    const states: string[] = [];
    (window as unknown as { avatarStates: string[] }).avatarStates = states;
    new MutationObserver((records) => {
      for (const record of records)
        if (record.attributeName === 'data-state') states.push((record.target as Element).getAttribute('data-state')!);
    }).observe(document.querySelector('main')!, { attributes: true, subtree: true });
  });
  await composer(page).fill('slow plant motion');
  await composer(page).press('Enter');
  await expect(page.getByText('Thinking about it slowly.', { exact: false })).toBeVisible();
  await expect(page.getByRole('main').locator('svg[data-state="speaking"]')).toHaveCount(1);
  await expect(page.locator('.app-message.is-reply .app-message-author')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible({ timeout: 20000 });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { avatarStates: string[] }).avatarStates))
    .toContain('done');
  await expect(page.getByRole('main').locator('svg[data-state="done"]')).toHaveCount(0, { timeout: 4000 });
});
