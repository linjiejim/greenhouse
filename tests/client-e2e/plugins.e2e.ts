import { test, expect, type Page } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { installPlaces, officialManifest } from './p3-fixture';
const endpoint = '/api/ext/crm/entities/company';
async function pluginStation(page: Page, { token404 = false } = {}) {
  const base = await installPlaces(page),
    writes: { method: string; path: string; body: any }[] = [],
    queries: URLSearchParams[] = [];
  let rows = Array.from({ length: 61 }, (_, i) => ({
    id: String(i + 1),
    name: i === 0 ? 'Acme Analytics' : `Customer ${i + 1}`,
    status: i % 2 ? 'closed' : 'open',
    amount: i + 100,
    notes: 'Shared notes',
  }));
  const entities = [
    {
      id: 'crm.company',
      title: { zh: '客户', en: 'Company' },
      title_field: 'name',
      fields: [
        {
          key: 'name',
          title: { zh: '名称', en: 'Name' },
          kind: 'text',
          required: true,
          writable: true,
          sortable: true,
        },
        {
          key: 'status',
          title: { zh: '状态', en: 'Status' },
          kind: 'enum',
          values: ['open', 'closed'],
          filterable: true,
          writable: true,
        },
        { key: 'amount', title: { zh: '金额', en: 'Amount' }, kind: 'money', writable: true, sortable: true },
        { key: 'notes', title: { zh: '备注', en: 'Notes' }, kind: 'longText', writable: true },
      ],
      views: [
        {
          id: 'default',
          columns: ['name', 'status', 'amount'],
          filters: ['status'],
          sort: { field: 'name', dir: 'asc' },
        },
      ],
      actions: ['read', 'update', 'delete'],
      endpoint,
      kind: 'ext:crm:company',
    },
  ];
  const manifest = officialManifest() as any;
  manifest.plugins.push({
    id: 'crm',
    name: 'CRM',
    version: '1.0.0',
    official: false,
    features: [],
    mcp_groups: [],
    entity_kinds: [],
    entities,
    nav: [
      { id: 'crm', label: { zh: '客户' }, page: 'companies', icon: 'Building2', placement: 'more' },
      { id: 'crm-settings', label: { zh: '客户设置' }, page: 'settings', icon: 'Settings', placement: 'more' },
      { id: 'crm-embed', label: { zh: '客户工作台' }, page: 'embed', icon: 'Layout', placement: 'more' },
      { id: 'future', label: { zh: '未来页面' }, page: 'future', icon: 'Box', placement: 'more' },
    ],
    pages: [
      { id: 'companies', kind: 'entity-list', entity: 'crm.company', title: { zh: '客户' } },
      { id: 'company', kind: 'entity-detail', entity: 'crm.company', title: { zh: '客户详情' } },
      {
        id: 'settings',
        kind: 'settings-form',
        settings: ['crm.app_id', 'crm.enabled', 'crm.secret'],
        parent: 'settings',
        title: { zh: '客户设置' },
      },
      { id: 'embed', kind: 'embed', url: 'http://localhost:18920/ext/crm/ui/', title: { zh: '客户工作台' } },
      { id: 'future', kind: 'future-kind', title: 'Future', fallback_url: '/classic/#/crm' },
    ],
  });
  let tokenCount = 0;
  let settings = [
    { key: 'crm.app_id', label: 'App ID', type: 'string', value: 'initial' },
    { key: 'crm.enabled', label: 'Enabled', type: 'boolean', value: true },
    { key: 'crm.secret', label: 'Secret', type: 'string', secret: true, has_value: true },
  ];
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      u = new URL(req.url()),
      path = u.pathname,
      method = req.method();
    const body = method === 'GET' ? null : req.postDataJSON();
    const json = (value: unknown) => route.fulfill({ json: value });
    if (!['GET', 'OPTIONS'].includes(method)) writes.push({ method, path, body });
    if (path === '/api/extensions') return json(manifest);
    if (path === endpoint) {
      queries.push(u.searchParams);
      let result = [...rows];
      const filter = JSON.parse(u.searchParams.get('filter') || '[]');
      for (const f of filter) result = result.filter((row) => row[f.key as 'status'] === f.value[0]);
      const sort = JSON.parse(u.searchParams.get('sort') || '[]');
      if (sort[0])
        result.sort(
          (a, b) =>
            String(a[sort[0].key as 'name']).localeCompare(String(b[sort[0].key as 'name'])) *
            (sort[0].order === 'desc' ? -1 : 1),
        );
      const skip = Number(u.searchParams.get('skip') || 0);
      return json({ items: result.slice(skip, skip + 50), total: result.length });
    }
    if (path.startsWith(endpoint + '/')) {
      const id = path.split('/').at(-1);
      const row = rows.find((row) => row.id === id);
      if (method === 'PATCH') {
        Object.assign(row!, body);
        return json(row);
      }
      if (method === 'DELETE') {
        rows = rows.filter((row) => row.id !== id);
        return json({ ok: true });
      }
      return json(row);
    }
    if (path === '/api/admin/settings') {
      if (method === 'PUT')
        settings = settings.map((s) => (s.key in body.values ? { ...s, value: body.values[s.key] } : s));
      return json({ settings });
    }
    if (path === '/api/ext-ui/token') {
      tokenCount++;
      return token404
        ? route.fulfill({ status: 404, json: { error: 'older station' } })
        : json({ token: `scoped-${tokenCount}`, expires_at: '2026-10-27T10:00:00Z' });
    }
    return route.fallback();
  });
  await page.route('**/ext/crm/ui/**', (route) =>
    route.fulfill({
      body: readFileSync('tests/client-e2e/fixtures/plugin-embed.html', 'utf8'),
      contentType: 'text/html',
    }),
  );
  return { ...base, writes, queries, tokenCount: () => tokenCount };
}
async function ready(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByTestId('startup-splash')).toHaveCount(0);
}
async function screenshot(page: Page, name: string) {
  mkdirSync('tests/client-e2e/__screenshots__', { recursive: true });
  await page.screenshot({ path: `tests/client-e2e/__screenshots__/c4-plugin-${name}.png` });
}
test('Plugins entity list filters, sort, infinite pages, inspector edit and confirmed delete', async ({ page }) => {
  const f = await pluginStation(page);
  await ready(page, '/p/crm/companies');
  const list = page.getByTestId('plugin-entity-list');
  await expect(list.getByText('Acme Analytics', { exact: true })).toBeVisible();
  await expect(list.locator('tbody tr').first()).toHaveCSS('height', '32px');
  await expect(list.locator('td').filter({ hasText: '100.00' }).first()).toHaveCSS('text-align', 'right');
  await screenshot(page, 'entity-list');
  await page.evaluate(() => localStorage.setItem('greenhouse_pref_theme', 'dark'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(list.getByText('Acme Analytics', { exact: true })).toBeVisible();
  await screenshot(page, 'entity-list-dark');
  await page.evaluate(() => localStorage.setItem('greenhouse_pref_theme', 'light'));
  await page.reload();
  await expect(list.getByText('Acme Analytics', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '状态', exact: true }).click();
  await page.getByRole('menuitem', { name: 'open', exact: true }).click();
  await expect
    .poll(() => f.queries.some((q) => JSON.parse(q.get('filter') || '[]')[0]?.value[0] === 'open'))
    .toBeTruthy();
  await page.getByRole('button', { name: '状态', exact: true }).click();
  await page.getByRole('menuitem', { name: '全部', exact: true }).click();
  await page.getByRole('button', { name: '排序', exact: true }).click();
  await page.getByRole('menuitem', { name: '金额 ↓', exact: true }).click();
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await expect.poll(() => f.queries.some((q) => q.get('skip') === '50')).toBeTruthy();
  await list.getByRole('row', { name: 'Acme Analytics', exact: true }).click();
  const inspector = page.getByTestId('client-inspector').filter({ visible: true });
  await expect(inspector).toContainText('Shared notes');
  await expect(list.getByRole('row', { name: 'Acme Analytics', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await list.getByRole('row', { name: 'Acme Analytics', exact: true }).getByText('open', { exact: true }).click();
  await expect(inspector).toContainText('Shared notes');
  await screenshot(page, 'entity-detail');
  await inspector.getByRole('button', { name: '编辑记录', exact: true }).click();
  await inspector.getByRole('textbox', { name: '名称', exact: true }).fill('Acme Updated');
  await inspector.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => f.writes.some((w) => w.method === 'PATCH' && w.body.name === 'Acme Updated')).toBeTruthy();
  await expect(inspector).toContainText('Acme Updated');
  await inspector.getByRole('button', { name: '删除记录', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
  await expect(inspector).toHaveCount(0);
  await expect.poll(() => f.writes.some((w) => w.method === 'DELETE')).toBeTruthy();
  await expect(list.getByRole('row', { name: 'Acme Updated', exact: true })).toHaveCount(0);
});
test('Plugins settings form saves only changed manifest keys, keeps secrets masked', async ({ page }) => {
  const f = await pluginStation(page);
  await ready(page, '/p/crm/settings');
  await page.getByRole('textbox', { name: 'crm.app_id', exact: true }).fill('new-app');
  await expect(page.getByLabel('crm.secret', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect
    .poll(() => f.writes.find((w) => w.path === '/api/admin/settings')?.body)
    .toEqual({ values: { 'crm.app_id': 'new-app' } });
  await screenshot(page, 'settings-form');
});
test('Plugins embed init, trusted origin, theme, token refresh, navigate and draft-only sendPrompt', async ({
  page,
}) => {
  const f = await pluginStation(page);
  await ready(page, '/p/crm/embed');
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#state')).toContainText('greenhouse:init');
  await expect(frame.locator('#state')).toContainText('scoped-');
  await expect(frame.locator('#state')).toContainText('--gh-accent');
  await expect(page.getByText('客户工作台 · 已连接', { exact: true }).first()).toBeVisible();
  await screenshot(page, 'embed-light');
  await page.evaluate(() => window.postMessage({ type: 'greenhouse:navigate', href: '/projects' }, location.origin));
  await expect(page).toHaveURL(/p\/crm\/embed/);
  await page.keyboard.press('Meta+,');
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(frame.locator('body')).toHaveCSS('color', 'rgb(242, 246, 240)');
  await screenshot(page, 'embed-dark');
  const count = f.tokenCount();
  await frame.locator('#refresh').click();
  await expect.poll(f.tokenCount).toBeGreaterThan(count);
  await expect(frame.locator('#state')).toContainText('greenhouse:token');
  await frame.locator('#navigate').click();
  await expect(page).toHaveURL(/\/knowledge/);
  await ready(page, '/p/crm/embed');
  await frame.locator('#prompt').click();
  await expect(page.getByTestId('composer-input').filter({ visible: true })).toHaveValue('请整理这位客户的资料');
  expect(f.station.calls).toHaveLength(0);
  await screenshot(page, 'embed-draft');
});
test('Plugins old token endpoint sends empty token and future page preserves fallback', async ({ page }) => {
  await pluginStation(page, { token404: true });
  await ready(page, '/p/crm/embed');
  await expect(page.frameLocator('iframe').locator('#state')).toContainText('"token":""');
  await ready(page, '/p/crm/future');
  await expect(page.getByText('此客户端不支持，在浏览器打开')).toBeVisible();
  await screenshot(page, 'unknown-kind');
});
test('Plugins native navigation requires a declared nav entry, known screen ids render', async ({ page }) => {
  await pluginStation(page);
  await ready(page, '/');
  await expect(page.getByTestId('rail-knowledge')).toBeVisible();
  await page.route('**/api/extensions', (route) =>
    route.fulfill({
      json: { ...officialManifest(), plugins: officialManifest().plugins.map((p) => ({ ...p, nav: [] })) },
    }),
  );
  await page.reload();
  await expect(page.getByTestId('startup-splash')).toHaveCount(0);
  await expect(page.getByTestId('rail-knowledge')).toHaveCount(0);
  await expect(page.getByTestId('rail-tables')).toHaveCount(0);
  await expect(page.getByTestId('rail-projects')).toHaveCount(0);
});
