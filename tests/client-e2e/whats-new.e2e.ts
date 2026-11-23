import { test, expect, type Page } from '@playwright/test';

// What's new after an update (jim-uiux 1.7.0 patterns/updates): the first launch on a newer version
// says so once with an action that opens the notes since the version this browser had; Settings
// lists every release. The notes are the CHANGELOG.md the bundle was built from.
const shots = '.work/whats-new';
const SEEN = 'greenhouse_pref_releaseNotesSeen';

async function ready(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByTestId('startup-splash')).toHaveCount(0);
}

/** The pref's key in this browser (development builds suffix it with the station's origin). */
async function seenKey(page: Page): Promise<string> {
  await expect
    .poll(() => page.evaluate((prefix) => Object.keys(localStorage).find((key) => key.startsWith(prefix)) ?? '', SEEN))
    .not.toBe('');
  return page.evaluate((prefix) => Object.keys(localStorage).find((key) => key.startsWith(prefix))!, SEEN);
}

const notice = (page: Page) => page.locator('.gh-notice').filter({ hasText: '已更新到' });

test.use({ viewport: { width: 1440, height: 900 } });

test('after an update: said once, the notes since the last version, every release in Settings', async ({ page }) => {
  // this browser has opened the app before (sign-in): its version is remembered, nothing is said
  await ready(page, '/');
  await expect(page.getByTestId('composer-input')).toBeVisible();
  const key = await seenKey(page);
  const current = await page.evaluate((k) => localStorage.getItem(k), key);
  expect(current).toMatch(/^\d+\.\d+\.\d+/);
  await expect(notice(page)).toHaveCount(0);

  // the last version this browser opened was 3.0.2: 4.0 and everything after it is new
  await page.evaluate((k) => localStorage.setItem(k, '3.0.2'), key);
  await ready(page, '/');
  await expect(notice(page)).toHaveText(new RegExp(`已更新到 ${current!.replace(/\./g, '\\.')}`));
  await expect(page.evaluate((k) => localStorage.getItem(k), key)).resolves.toBe(current);
  await page.screenshot({ path: `${shots}/notice.png` });
  // info with an action stays 8 s, longer than a plain notice's 4
  await page.waitForTimeout(5000);
  await expect(notice(page)).toBeVisible();
  await notice(page).getByRole('button', { name: '查看更新内容', exact: true }).click();

  const sheet = page.getByTestId('client-sheet').filter({ visible: true });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('更新内容', { exact: true }).first()).toBeVisible();
  const notes = sheet.getByTestId('whats-new');
  await expect(notes.getByText(current!, { exact: true })).toBeVisible();
  await expect(notes.getByText('4.0.0-rc.1', { exact: true })).toBeAttached();
  // the seen version and the ones before it are not new
  await expect(notes.getByText('3.0.2', { exact: true })).toHaveCount(0);
  // commit and PR links and release-please's scopes never show
  await expect(notes).not.toContainText('github.com');
  await expect(notes).toContainText('embeds own their Back while a sub-view is open');
  await expect(notes).not.toContainText('plugins: embeds');
  await page.screenshot({ path: `${shots}/dialog.png` });
  // the 4.0 breaking changes are a warning notice headed 注意
  await notes.getByText('4.0.0-rc.2', { exact: true }).scrollIntoViewIfNeeded();
  const headsUp = notes.locator('.gh-callout[data-tone="warning"]').first();
  await expect(headsUp).toContainText('注意');
  await expect(headsUp).toContainText('Greenhouse 4.0 plugin platform');
  await headsUp.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/heads-up.png` });
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  // said once
  await ready(page, '/');
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(notice(page)).toHaveCount(0);

  // Settings › Account › About lists every release, the first one included
  await ready(page, '/me/account');
  const settings = page.getByTestId('settings-overlay');
  await expect(settings).toBeVisible();
  await settings.getByText('更新内容', { exact: true }).click();
  const all = settings.getByTestId('whats-new');
  await expect(all.getByText(current!, { exact: true })).toBeVisible();
  await expect(all.getByText('3.0.2', { exact: true })).toBeAttached();
  await page.screenshot({ path: `${shots}/settings.png` });
});

test.describe('phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the notes open as a sheet', async ({ page }) => {
    await ready(page, '/');
    const key = await seenKey(page);
    await page.evaluate((k) => localStorage.setItem(k, '4.3.0'), key);
    await ready(page, '/');
    await notice(page).getByRole('button', { name: '查看更新内容', exact: true }).click();
    const sheet = page.getByTestId('client-sheet').filter({ visible: true });
    await expect(sheet.getByTestId('whats-new')).toBeVisible();
    await expect(sheet.getByTestId('whats-new').getByText('4.3.0', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: `${shots}/phone.png` });
  });
});
