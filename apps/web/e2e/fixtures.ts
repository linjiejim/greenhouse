import { expect, type Page, type Locator } from '@playwright/test';
import type { NeedsYou } from '@greenhouse/contract';
import { PEOPLE } from './env';

/** A session saved by e2e/auth.setup.ts; `signedOut` starts at the sign-in page. */
export const as = (person: keyof typeof PEOPLE) => `e2e/.auth/${person}.json`;
export const signedOut = { cookies: [], origins: [] };

/** Opens a page with the saved session and waits for its header. */
export async function open(page: Page, path = '/') {
  await page.goto(path);
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
}

/** Signs in through the form (spends one attempt of the sign-in rate limit). */
export async function signIn(page: Page, person: keyof typeof PEOPLE = 'lin') {
  await page.goto('/');
  await page.getByLabel(/邮箱|Email/).fill(PEOPLE[person].email);
  await page.getByLabel(/密码|Password/).fill(PEOPLE[person].password);
  await page.getByRole('button', { name: /登录|Sign in/ }).click();
  // The main thread's composer: there on every screen size.
  await expect(composer(page)).toBeVisible();
}

/** The composer of the open conversation. */
export const composer = (page: Page) => page.getByRole('textbox', { name: /发消息|Message/ });

/** Opens the reply's one action menu; keyboard access uses the same trigger. */
export async function messageMenu(message: Locator) {
  const trigger = message.getByRole('button', { name: '消息操作', exact: true });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  return message.getByRole('menu', { name: '消息操作' });
}

/** Wait for the committed request response before inspecting its rendered details. */
export async function sendForRequest(
  page: Page,
  conversationId: string | undefined,
  prompt: string,
  previousId?: string,
) {
  const pending = page.waitForResponse(async (response) => {
    const url = new URL(response.url());
    if (
      url.pathname !== '/api/requests' ||
      (conversationId !== undefined && url.searchParams.get('conversation_id') !== conversationId) ||
      !response.ok()
    )
      return false;
    const data = (await response.json()) as { items: NeedsYou[] };
    return data.items.some((item) => item.status === 'pending' && item.id !== previousId);
  });
  await composer(page).fill(prompt);
  await composer(page).press('Enter');
  await pending;
}
