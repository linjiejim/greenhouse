import { expect, test } from '@playwright/test';
import { apiAs } from './api';
import { open, sendForRequest } from './fixtures';

/** Uses the real request service and two simultaneously open clients. */
test('a newer approval replaces its card and clears notifications on another client', async ({ page, request }) => {
  const folder = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/knowledge/folders', {
    name: 'U3 shared drafts',
    space: 'team',
  });
  await open(page, '/#/c/new');
  await sendForRequest(page, undefined, `shared draft in ${folder.id} old plan`);
  const card = page.locator('[id^="request-"] .gh-chat-card', { hasText: 'Shared agent draft' });
  await expect(card.getByRole('button', { name: '批准', exact: true })).toBeEnabled();
  const conversation = /#\/c\/([^?]+)/.exec(page.url())![1]!;
  const pending = await apiAs<{ items: { id: string }[] }>(
    request,
    'lin',
    'GET',
    `/api/requests?conversation_id=${conversation}`,
  );
  const old = pending.items[0]!.id;
  const notifications = await page.context().newPage();
  await open(notifications, '/#/notifications');
  await expect(notifications.getByRole('main').locator(`a[href*="request=${old}"]`)).toBeVisible();
  await sendForRequest(page, conversation, `shared draft in ${folder.id} newer plan`, old);
  const replaced = page.getByRole('link', { name: '已被新的请求取代', exact: true });
  await expect(replaced).toBeVisible();
  await expect(notifications.getByRole('main').locator(`a[href*="request=${old}"]`)).toHaveCount(0);
  await expect(card).toHaveCount(1);
  await expect(page.locator(`#request-${old} button`)).toHaveCount(0);
  await expect(card.locator('.gh-chat-card-footer button').first()).toHaveText('批准');
  await replaced.click();
  await expect(page).toHaveURL(/request=req_/);
  await expect(card).toBeInViewport();

  for (const [name, width, dark] of [
    ['light', 1440, false],
    ['dark', 1440, true],
    ['narrow', 390, false],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((dark) => {
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    }, dark);
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {})),
      ),
    );
    await page.screenshot({ path: `../../artifacts/u1/integration/requests-${name}.png`, fullPage: true });
  }
  await card.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(notifications.getByRole('main').getByText('U3 shared drafts', { exact: false })).toHaveCount(0);
  const list = await apiAs<{ items: { request_id: string | null }[] }>(request, 'lin', 'GET', '/api/notifications');
  const all = await apiAs<{ items: { id: string }[] }>(
    request,
    'lin',
    'GET',
    `/api/requests?state=all&conversation_id=${conversation}`,
  );
  expect(list.items.filter((item) => all.items.some((card) => card.id === item.request_id))).toEqual([]);
  for (const [name, width, dark] of [
    ['light', 1440, false],
    ['dark', 1440, true],
    ['narrow', 390, false],
  ] as const) {
    await notifications.setViewportSize({ width, height: 900 });
    await notifications.evaluate((dark) => {
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    }, dark);
    await notifications.screenshot({ path: `../../artifacts/u3/notifications-${name}.png`, fullPage: true });
  }
  await notifications.close();
});
