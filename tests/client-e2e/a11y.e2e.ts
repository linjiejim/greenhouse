import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { installStation, DOC } from './p2-fixture';
import { installPlaces, officialManifest, PROJECT } from './p3-fixture';
import { installCollab, PRIVATE_DOC } from './collab-fixture';

/**
 * Accessibility: axe-core (root devDependency, injected without a CDN) on representative pages
 * and dialogs in both appearances, failing on serious or critical violations; and the keyboard
 * paths (rail and More, composer, a modal sheet's focus trap and Esc).
 */
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
/**
 * Accepted findings, by rule and the element they sit on (CSS, matched with closest()):
 * label-content-name-mismatch is axe's experimental heuristic. A task card and an app row are one
 * button named by their visible title (WCAG 2.5.3 holds: the title is the label, the rest of the
 * card is description); the editor's numbered-list button draws an aria-hidden "1." glyph.
 */
const ALLOWED: Record<string, string> = {
  'label-content-name-mismatch': '.gh-task-card, .gh-app-row-main, .gh-editor-toolbar',
};

async function axe(page: Page, name: string) {
  if (!(await page.evaluate(() => 'axe' in window))) await page.addScriptTag({ content: AXE });
  const found = await page.evaluate(async (allowed) => {
    const result = await (window as any).axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
      resultTypes: ['violations'],
    });
    return result.violations.flatMap((v: any) =>
      ['serious', 'critical'].includes(v.impact)
        ? v.nodes
            .filter((n: any) => {
              const el = typeof n.target[0] === 'string' ? document.querySelector(n.target[0]) : null;
              return !(allowed[v.id] && el?.closest(allowed[v.id]));
            })
            .map((n: any) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
        : [],
    );
  }, ALLOWED);
  expect(found, `axe on ${name}`).toEqual([]);
}

const ready = async (page: Page, path: string) => {
  await page.goto(path);
  await expect(page.getByTestId('startup-splash')).toHaveCount(0);
};
const sheet = (page: Page) => page.getByTestId('client-sheet').filter({ visible: true });

/** Email, Memory and Computer as installed plugins with one row each, and Admin's users. */
async function installAppPages(page: Page) {
  await installPlaces(page);
  const manifest = officialManifest() as any;
  for (const [id, label, icon] of [
    ['email', '邮件', 'Mail'],
    ['memory', '记忆', 'Brain'],
    ['computer', '云电脑', 'Monitor'],
  ])
    manifest.plugins.push({
      id,
      name: id,
      version: '4.0.0',
      official: true,
      description: null,
      features: [],
      mcp_groups: [],
      entity_kinds: [],
      entities: [],
      nav: [{ id, label: { zh: label, en: id }, page: id, icon, placement: 'more', order: 10 }],
      pages: [{ id, title: { zh: label, en: id }, kind: 'native', screen: id }],
    });
  const at = '2026-10-28T09:00:00Z';
  const row = { status: 'active', created_at: at, updated_at: at };
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (value: unknown) => route.fulfill({ json: value });
    if (path === '/api/extensions') return json(manifest);
    if (path === '/api/email/presets') return json({ presets: [] });
    if (path === '/api/email/accounts')
      return json({
        accounts: [
          {
            ...row,
            id: 'ema_01JB2Y8Z9QW3E4R5T6Y7V8H9Q1',
            email_address: 'jim@example.com',
            display_name: 'Jim Work',
            username: 'jim@example.com',
            imap_host: 'imap.gmail.com',
            error_message: null,
            last_verified_at: at,
          },
        ],
      });
    if (path === '/api/auth/me/memories')
      return json({
        memories: [
          {
            ...row,
            id: 'mem_01JB2Y8Z9QW3E4R5T6Y7V8H9P1',
            category: 'preference',
            title: '喜欢用表格展示数字',
            content: '详细说明。',
            pinned: true,
            source: 'agent',
            superseded_by: null,
            last_used_at: at,
          },
        ],
      });
    if (path === '/api/computer')
      return json({
        enabled: true,
        configured: true,
        price_per_minute_usd: 0.0021,
        idle_minutes: 15,
        computer: null,
        minutes_this_month: 42,
        period: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
      });
    if (path === '/api/admin/users')
      return json({
        users: [
          {
            ...row,
            id: 'member',
            email: 'jim@test.local',
            nickname: 'Jim Lin',
            role: 'super',
            last_login_at: null,
            usage_summary: null,
            password_link: null,
          },
        ],
      });
    return route.fallback();
  });
}

test.use({ viewport: { width: 1440, height: 900 } });

test('axe: home, conversation, Me and the settings window', async ({ page }) => {
  await installStation(page);
  await ready(page, '/');
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await axe(page, 'home');
  await ready(page, '/chat?session=policy-chat');
  await expect(page.getByText('居家补贴多少', { exact: false }).first()).toBeVisible();
  await axe(page, 'conversation');
  for (const path of ['/me', '/me/connectors', '/me/agents', '/me/activity']) {
    await ready(page, path);
    await expect(page.getByTestId('settings-overlay')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await axe(page, path);
  }
});

test('axe: Knowledge, Projects, Tables, Automations and their dialogs', async ({ page }) => {
  await installCollab(page);
  await ready(page, `/knowledge?doc=${DOC}`);
  await expect(page.getByTestId('knowledge-document')).toContainText('远程办公政策');
  await axe(page, 'knowledge document');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '正文', exact: true })).toBeVisible();
  await axe(page, 'knowledge editor');
  await ready(page, `/knowledge?shelf=personal&doc=${PRIVATE_DOC}`);
  await page.getByRole('button', { name: '共享', exact: true }).click();
  await expect(page.getByTestId('doc-share-list')).toContainText('王宁');
  await axe(page, 'document share dialog');
  await ready(page, '/doc-new?shelf=team');
  await expect(sheet(page)).toBeVisible();
  await axe(page, 'new document dialog');
  await ready(page, '/projects');
  await expect(page.getByTestId('project-kanban')).toContainText('定价页文案');
  await axe(page, 'projects');
  await page.getByRole('button', { name: '成员', exact: true }).click();
  await expect(page.getByTestId('project-members-list')).toContainText('王宁');
  await axe(page, 'project members dialog');
  await ready(page, `/task-form?project=${PROJECT}`);
  await expect(sheet(page)).toBeVisible();
  await axe(page, 'task form');
  await ready(page, '/sheets/feedback');
  await expect(sheet(page)).toBeVisible();
  await axe(page, 'feedback dialog');
  await ready(page, '/drive?view=tables');
  await expect(page.getByRole('row', { name: /Wayne Enterprises/ })).toBeVisible();
  await axe(page, 'tables');
  await ready(page, '/automations');
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await axe(page, 'automations');
});

test('axe: Admin and the Email, Memory and Computer plugin pages', async ({ page }) => {
  await installAppPages(page);
  await ready(page, '/admin');
  await expect(page.getByTestId('admin-users')).toContainText('Jim Lin');
  await axe(page, 'admin users');
  await page.getByTestId('admin-users-add').click();
  await expect(page.getByTestId('admin-user-create')).toBeVisible();
  await axe(page, 'admin create user dialog');
  await ready(page, '/p/email/email');
  await expect(page.getByTestId('email-accounts')).toContainText('Jim Work');
  await axe(page, 'email');
  await ready(page, '/p/memory/memory');
  await expect(page.getByTestId('memory-inUse')).toContainText('喜欢用表格展示数字');
  await axe(page, 'memory');
  await ready(page, '/p/computer/computer');
  await expect(page.getByTestId('computer-status')).toContainText('未运行');
  await axe(page, 'computer');
});

test('axe: dark appearance (contrast against the dark tokens)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('greenhouse_pref_theme', 'dark'));
  await installCollab(page);
  await ready(page, '/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await axe(page, 'dark home');
  await ready(page, `/knowledge?doc=${DOC}`);
  await expect(page.getByTestId('knowledge-document')).toContainText('远程办公政策');
  await axe(page, 'dark knowledge');
  await ready(page, '/projects');
  await page.getByRole('button', { name: '成员', exact: true }).click();
  await expect(page.getByTestId('project-members-list')).toContainText('王宁');
  await axe(page, 'dark project members dialog');
  await ready(page, `/task-form?project=${PROJECT}`);
  await expect(sheet(page)).toBeVisible();
  await axe(page, 'dark task form');
});

test('keyboard: the rail and its More flyout, the composer, and visible focus', async ({ page }) => {
  await installAppPages(page);
  await ready(page, '/');
  // the rail's places come in order, then More, which opens its flyout from the keyboard
  await page.getByTestId('rail-chat').focus();
  await expect(page.getByTestId('rail-chat')).toHaveCSS('outline-style', 'solid');
  const order: string[] = [];
  for (let i = 0; i < 12 && order.at(-1) !== 'rail-more'; i++) {
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? ''));
  }
  expect(order).toEqual([
    'rail-knowledge',
    'rail-drive',
    'rail-tables',
    'rail-projects',
    'rail-automations',
    'rail-more',
  ]);
  const more = page.getByTestId('rail-more');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('rail-more-menu')).toBeVisible();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menuitem', { name: '邮件' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: '记忆' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('rail-more-menu')).toHaveCount(0);
  await expect(more).toBeFocused();

  // from the top of the main pane, Tab reaches the composer and every stop on the way has a name
  await page.getByTestId('client-main').evaluate((main) => {
    main.setAttribute('tabindex', '-1');
    main.focus();
  });
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      return {
        composer: el.dataset.testid === 'composer-input',
        name: el.getAttribute('aria-label') || el.textContent?.trim() || el.getAttribute('placeholder') || '',
        html: el.outerHTML.slice(0, 120),
      };
    });
    expect(stop.name, `tab stop ${i}: ${stop.html}`).not.toBe('');
    if (stop.composer) break;
  }
  await expect(page.getByTestId('composer-input')).toBeFocused();
});

test('keyboard: a modal sheet is a named dialog that keeps focus inside and closes on Esc', async ({ page }) => {
  await installCollab(page);
  await ready(page, '/sheets/feedback');
  const dialog = page.getByRole('dialog', { name: '发送反馈' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  // focus starts inside and Tab never leaves it: the rail and the page behind are out of reach
  for (let i = 0; i < 12; i++) {
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press(i % 4 === 3 ? 'Shift+Tab' : 'Tab');
  }
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
  // the page behind is usable again: nothing is left inert
  await expect(page.locator('[inert]')).toHaveCount(0);

  // an Overlay dialog (project members) is named by its title and traps Tab the same way
  await ready(page, '/projects');
  await page.getByRole('button', { name: '成员', exact: true }).click();
  const members = page.getByTestId('project-members');
  await expect(members).toHaveAttribute('role', 'dialog');
  await expect(members).toHaveAccessibleName(/成员/);
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab');
    expect(await members.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(members).toHaveCount(0);
});
