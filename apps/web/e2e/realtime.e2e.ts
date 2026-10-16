import { expect, test } from '@playwright/test';
import { apiAs } from './api';
import { composer, open } from './fixtures';

declare global {
  interface Window {
    /** Set by the test: new sockets fail to connect, as with the network gone. */
    __offline?: boolean;
    __sockets?: WebSocket[];
  }
}

test('after the connection drops, the open conversation catches up without fetching everything again', async ({
  page,
  request,
}) => {
  // Keep the app's realtime sockets at hand (not Vite's, which reloads the page when it drops),
  // and let the test cut the network for them.
  await page.addInitScript(() => {
    const Real = window.WebSocket;
    window.__sockets = [];
    window.WebSocket = class extends Real {
      constructor(url: string | URL, protocols?: string | string[]) {
        const realtime = String(url).includes('/api/ws');
        super(realtime && window.__offline ? 'ws://127.0.0.1:9/offline' : url, protocols);
        if (realtime) window.__sockets!.push(this);
      }
    } as typeof WebSocket;
  });
  await open(page);
  await composer(page).fill('before the drop');
  await composer(page).press('Enter');
  await expect(page.getByText('Echo: before the drop')).toBeVisible();
  const { items } = await apiAs<{ items: { id: string; kind: string }[] }>(request, 'lin', 'GET', '/api/conversations');
  const main = items.find((item) => item.kind === 'main')!;

  await page.evaluate(() => {
    window.__offline = true;
    for (const socket of window.__sockets!) socket.close();
  });
  // Lin writes from another screen while this one is away; the reply comes and goes unseen here.
  await apiAs(request, 'lin', 'POST', `/api/conversations/${main.id}/messages`, { content: 'while away' });
  await expect
    .poll(async () => {
      const page = await apiAs<{ items: { content: string; status: string }[] }>(
        request,
        'lin',
        'GET',
        `/api/conversations/${main.id}/messages?limit=5`,
      );
      return page.items.some((message) => message.content === 'Echo: while away' && message.status === 'complete');
    })
    .toBe(true);

  const fetched: string[] = [];
  page.on('request', (sent) => {
    const url = new URL(sent.url());
    if (sent.method() === 'GET' && url.pathname === `/api/conversations/${main.id}/messages`) fetched.push(url.search);
  });
  await page.evaluate(() => {
    window.__offline = false;
    window.dispatchEvent(new Event('online'));
  });
  await expect(page.getByText('Echo: while away')).toBeVisible({ timeout: 20_000 });
  // Caught up from where it was, not page by page from the start.
  expect(fetched.length).toBeGreaterThan(0);
  expect(fetched.every((search) => search.includes('after='))).toBe(true);
});

test('an older initial page cannot remove a live reply or its decided card', async ({ page, request }) => {
  const chat = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/conversations', { kind: 'chat' });
  let release!: () => void;
  let snapshot!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    snapshot = resolve;
  });
  let intercepted = false;
  await page.route(`**/api/conversations/${chat.id}/messages?*`, async (route) => {
    if (intercepted || route.request().method() !== 'GET') return route.continue();
    intercepted = true;
    const response = await route.fetch();
    snapshot();
    await held;
    await route.fulfill({ response });
  });
  await open(page, `/#/c/${chat.id}`);
  await ready;
  await composer(page).fill('need a human while the page is loading');
  await composer(page).press('Enter');
  const card = page.locator('.gh-chat-card', { hasText: '需要你接管电脑' });
  await expect(card.getByText('需要你', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: '交还电脑' }).click();
  await page.getByRole('dialog', { name: '交还电脑' }).getByRole('button', { name: '交还电脑' }).click();
  await expect(page.getByText('Done.', { exact: true })).toBeVisible();
  release();
  await expect(card.getByText('已交还', { exact: true })).toBeVisible();
  await expect(page.getByText('Done.', { exact: true })).toBeVisible();
});
