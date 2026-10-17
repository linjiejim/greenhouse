import { expect, test, type Page } from '@playwright/test';
import { as, open, signedOut } from './fixtures';
import { E2E } from './env';

/** The web origin; Vite proxies /api, so the page and its "server" stay same-origin. */
const WEB = `http://127.0.0.1:${E2E.webPort}`;

type Settings = { apiBaseUrl: string; apiBaseLocked: boolean };

/** Plays the desktop shell (apps/desktop): its globals and the commands this bundle calls. */
async function fakeShell(page: Page, settings: Settings, base = settings.apiBaseUrl) {
  await page.addInitScript(
    ({ settings, base }) => {
      const calls: [string, unknown][] = [];
      Object.assign(window, {
        __qaCalls: calls,
        __GREENHOUSE_DESKTOP_API_BASE__: base,
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args: Record<string, unknown>) => {
            calls.push([command, args]);
            if (command === 'desktop_get_settings') return settings;
            if (command === 'desktop_set_api_base') {
              if (settings.apiBaseLocked) throw new Error('The server is fixed in this build');
              return { ...settings, apiBaseUrl: args.url };
            }
            if (command === 'desktop_check_web_update') return { status: 'up_to_date' };
            if (command === 'desktop_info')
              return { shellVersion: '2.0.0', webBundleVersion: '600', platform: 'macos', arch: 'aarch64' };
            return undefined;
          },
        },
      });
    },
    { settings, base },
  );
}

const shellCalls = (page: Page, command: string) =>
  page.evaluate(
    (command) => (window as unknown as { __qaCalls: [string, unknown][] }).__qaCalls.filter(([c]) => c === command),
    command,
  );

test.describe('signed out', () => {
  test.use({ storageState: signedOut });

  test('first launch of an unlocked app asks for a server, checks it, then restarts into it', async ({ page }) => {
    // The setting is still the dev default; the page is served (and proxied) from WEB.
    await fakeShell(page, { apiBaseUrl: 'http://localhost:3000', apiBaseLocked: false }, WEB);
    await page.goto('/');
    const form = page.getByRole('form', { name: '连接服务器' });
    await expect(form).toBeVisible();
    await expect(page.getByLabel('密码')).toHaveCount(0);

    const address = form.getByLabel('服务器地址');
    await address.fill('http://example.com');
    await form.getByRole('button', { name: '连接' }).click();
    await expect(form.getByText('只能用 https 地址，http 只用于本机')).toBeVisible();

    await address.fill('https://example.com/base');
    await form.getByRole('button', { name: '连接' }).click();
    await expect(form.getByText('填写网址，例如 https://greenhouse.example.com')).toBeVisible();

    await address.fill(WEB);
    await form.getByRole('button', { name: '连接' }).click();
    await expect.poll(() => shellCalls(page, 'desktop_restart')).toHaveLength(1);
    expect(await shellCalls(page, 'desktop_set_api_base')).toEqual([['desktop_set_api_base', { url: WEB }]]);
  });

  test('a chosen server is named under sign-in and can be changed', async ({ page }) => {
    await page.addInitScript((web) => localStorage.setItem('greenhouse.desktop.server', web), WEB);
    await fakeShell(page, { apiBaseUrl: WEB, apiBaseLocked: false });
    await page.goto('/');
    await expect(page.getByLabel('密码')).toBeVisible();
    await expect(page.getByText(`服务器：127.0.0.1:${E2E.webPort}`)).toBeVisible();
    await page.getByRole('button', { name: '更换服务器' }).click();
    const form = page.getByRole('form', { name: '连接服务器' });
    await expect(form.getByLabel('服务器地址')).toHaveValue(WEB);
    await form.getByRole('button', { name: '取消' }).click();
    await expect(page.getByLabel('密码')).toBeVisible();
  });

  test('a build with a fixed server never offers one, even on first launch', async ({ page }) => {
    await fakeShell(page, { apiBaseUrl: 'http://localhost:3000', apiBaseLocked: true }, WEB);
    await page.goto('/');
    await expect(page.getByLabel('密码')).toBeVisible();
    await expect(page.getByLabel('服务器地址')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '更换服务器' })).toHaveCount(0);
  });
});

test.describe('as Kai', () => {
  test.use({ storageState: as('kai') });

  test('设置 → 桌面端 shows a fixed server read only, with the version and update check', async ({ page }) => {
    await fakeShell(page, { apiBaseUrl: WEB, apiBaseLocked: true });
    await open(page, '/#/settings/desktop');
    await expect(page.getByRole('heading', { name: '桌面端', level: 1 })).toBeVisible();
    await expect(page.getByText('这个 App 固定连接这台服务器')).toBeVisible();
    await expect(page.getByRole('button', { name: '更换服务器' })).toHaveCount(0);
    await expect(page.getByText('桌面 App 2.0.0 · 界面 600')).toBeVisible();
    await page.getByRole('button', { name: '检查更新' }).click();
    await expect(page.getByText('已是最新版本')).toBeVisible();
  });

  test('设置 → 桌面端 lets an unlocked app open the server form', async ({ page }) => {
    await fakeShell(page, { apiBaseUrl: WEB, apiBaseLocked: false });
    await open(page, '/#/settings/desktop');
    await page.getByRole('button', { name: '更换服务器' }).click();
    await expect(page.getByText('更换后会退出登录并重启 App')).toBeVisible();
    await expect(page.getByLabel('服务器地址')).toHaveValue(WEB);
    await page.getByRole('button', { name: '取消' }).click();
    await expect(page.getByLabel('服务器地址')).toHaveCount(0);
  });

  test('a browser has no 桌面端 settings', async ({ page }) => {
    await open(page, '/#/settings/account');
    await expect(page.getByRole('link', { name: '桌面端' })).toHaveCount(0);
    await page.goto('/#/settings/desktop');
    await expect(page.getByText('这个 App 固定连接这台服务器')).toHaveCount(0);
  });
});
