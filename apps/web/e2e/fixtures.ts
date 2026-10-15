import { expect, type Page, type Locator } from '@playwright/test';
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
