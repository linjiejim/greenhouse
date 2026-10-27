import { test, expect, type Page } from '@playwright/test';
import { installPlaces, officialManifest } from './p3-fixture';

const at = '2026-10-20T09:00:00Z';

/** The Admin place's station: users, a plugin with an Admin page (or not), recorded writes. */
async function adminStation(page: Page, { role = 'super', feedback = true } = {}) {
  await installPlaces(page);
  const writes: { method: string; path: string; body: any }[] = [];
  const users = [
    {
      id: 'member',
      email: 'jim@test.local',
      nickname: 'Jim Lin',
      role: 'super',
      status: 'active',
      created_at: at,
      last_login_at: at,
      usage_summary: { total_calls: 42, today_messages: 3, month_tokens: 125_000, last_used_at: at },
      password_link: null,
    },
    {
      id: 'wang',
      email: 'wang@test.local',
      nickname: '王宁',
      role: 'team',
      status: 'invited',
      created_at: at,
      last_login_at: null,
      usage_summary: null,
      password_link: {
        id: 'link-1',
        purpose: 'invite',
        expires_at: '2099-01-01T00:00:00Z',
        created_at: at,
        sent_at: at,
        delivery_status: 'sent',
        delivery_error: null,
      },
    },
    {
      id: 'chen',
      email: 'chen@test.local',
      nickname: '陈曦',
      role: 'external',
      status: 'disabled',
      created_at: at,
      last_login_at: null,
      usage_summary: null,
      password_link: null,
    },
  ];
  const manifest = officialManifest() as any;
  if (feedback)
    manifest.plugins.push({
      id: 'feedback',
      name: { en: 'Feedback', zh: '问题与需求' },
      version: '4.0.0',
      official: true,
      description: null,
      features: [],
      mcp_groups: [],
      entity_kinds: [],
      entities: [],
      nav: [],
      pages: [
        {
          id: 'issues',
          kind: 'native',
          screen: 'feedback-issues',
          title: { en: 'Issues & requests', zh: '问题与需求' },
          parent: 'administration',
          fallback_url: '#/administration/issues',
        },
      ],
    });
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      method = req.method();
    const body = ['POST', 'PATCH', 'PUT'].includes(method) ? req.postDataJSON() : null;
    const json = (value: unknown, status = 200) => route.fulfill({ json: value, status });
    if (!['GET', 'OPTIONS'].includes(method)) writes.push({ method, path, body });
    if (path === '/api/auth/me')
      return json({
        user: { id: 'member', role, nickname: 'Jim Lin', email: 'jim@test.local', locale: 'zh', features: {} },
      });
    if (path === '/api/extensions') return json(manifest);
    if (path === '/api/admin/users' && method === 'GET')
      return json({ users, password_link_capability: { available: true } });
    if (path === '/api/admin/users' && method === 'POST') {
      users.push({ ...users[1]!, id: 'new', email: body.email, nickname: body.nickname, status: 'active' });
      return json({ user: { id: 'new' } }, 201);
    }
    if (path.startsWith('/api/admin/users/') && method === 'PATCH') {
      const user = users.find((u) => u.id === path.split('/').at(-1));
      Object.assign(user!, body);
      return json({ user });
    }
    if (path === '/api/admin/feature-requests')
      return json({
        total: 1,
        requests: [
          {
            id: 'fr-1',
            title: '表格支持按周汇总',
            description: '希望能按周看汇总。',
            submitted_by_nickname: '王宁',
            submitted_by_role: 'team',
            status: 'pending',
            priority: 'normal',
            admin_note: null,
            session_id: null,
            created_at: at,
          },
        ],
      });
    if (path.startsWith('/api/admin/feature-requests/')) return json({ request: {} });
    return route.fallback();
  });
  return { writes, users };
}

async function ready(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByTestId('startup-splash')).toHaveCount(0);
}

test.use({ viewport: { width: 1440, height: 900 } });

test('Admin is hidden from members, and the place says so', async ({ page }) => {
  await adminStation(page, { role: 'team' });
  await ready(page, '/');
  await expect(page.getByTestId('rail-knowledge')).toBeVisible();
  await expect(page.getByTestId('rail-admin')).toHaveCount(0);
  await ready(page, '/admin');
  await expect(page.getByText('仅限管理员')).toBeVisible();
  await expect(page.getByTestId('admin-sections')).toHaveCount(0);
});

test('Rail Admin opens the place; users list, role edit and the create dialog', async ({ page }) => {
  const f = await adminStation(page);
  await ready(page, '/');
  await page.getByTestId('rail-admin').click();
  await expect(page).toHaveURL(/\/admin$/);
  const sections = page.getByTestId('admin-sections');
  await expect(sections.getByRole('button', { name: '用户', exact: true })).toHaveAttribute('aria-current', 'page');
  const list = page.getByTestId('admin-users');
  await expect(list.getByRole('row', { name: '王宁' })).toContainText('待激活');
  await expect(list.getByRole('row', { name: 'Jim Lin' })).toContainText('125.0K');
  await expect(list.locator('tbody tr').first()).toHaveCSS('height', '32px');
  // search narrows the list
  await page.getByRole('searchbox', { name: '搜索名称或邮箱' }).fill('chen');
  await expect(list.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('searchbox', { name: '搜索名称或邮箱' }).fill('');

  // a historical account converts to a team member from the edit dialog
  await list.getByRole('row', { name: '陈曦' }).click();
  const edit = page.getByTestId('admin-user-edit');
  await expect(edit).toBeVisible();
  await edit.getByLabel('角色').selectOption('team');
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  await expect(edit).toHaveCount(0);
  await expect.poll(() => f.writes.find((w) => w.method === 'PATCH')?.body).toEqual({ role: 'team' });
  expect(f.writes.find((w) => w.method === 'PATCH')?.path).toBe('/api/admin/users/chen');

  // the create dialog: a fixed-size dialog, a password setup, the station's create call
  await page.getByTestId('admin-users-add').click();
  const create = page.getByTestId('admin-user-create');
  await expect(create).toHaveCSS('width', '560px');
  await create.getByLabel('邮箱').fill('li@test.local');
  await create.getByLabel('名称').fill('李想');
  await create.getByLabel('密码设置方式').selectOption('direct_password');
  await create.getByRole('button', { name: '创建', exact: true }).click();
  await expect(create.getByRole('alert')).toContainText('至少 8 位');
  await create.getByRole('textbox', { name: '密码', exact: true }).fill('Passw0rd!x');
  await create.getByRole('button', { name: '创建', exact: true }).click();
  await expect(create).toHaveCount(0);
  expect(f.writes.find((w) => w.method === 'POST' && w.path === '/api/admin/users')?.body).toEqual({
    email: 'li@test.local',
    nickname: '李想',
    credential_mode: 'direct_password',
    password: 'Passw0rd!x',
    role: 'team',
  });
  await expect(list.getByRole('row', { name: '李想' })).toBeVisible();

  // ⌘K lists Administration as a place to go
  await page.keyboard.press('Meta+k');
  await expect(page.getByText('管理后台', { exact: true }).first()).toBeVisible();
  await page.keyboard.press('Escape');
});

test('A plugin Admin section appears only when its plugin is in the manifest', async ({ page }) => {
  await adminStation(page);
  await ready(page, '/admin');
  const sections = page.getByTestId('admin-sections');
  await expect(sections.getByRole('button', { name: '问题与需求', exact: true })).toBeVisible();
  await sections.getByRole('button', { name: '问题与需求', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/p\/feedback\/issues/);
  await expect(page.getByTestId('admin-requests')).toContainText('表格支持按周汇总');
  // a classic link to the section opens it too
  await ready(page, '/admin/issues');
  await expect(page).toHaveURL(/\/admin\/p\/feedback\/issues/);
});

test('Without the plugin in the manifest its Admin section is absent', async ({ page }) => {
  await adminStation(page, { feedback: false });
  await ready(page, '/admin');
  const sections = page.getByTestId('admin-sections');
  await expect(sections.getByRole('button', { name: '用户', exact: true })).toBeVisible();
  await expect(sections.getByRole('button', { name: '问题与需求', exact: true })).toHaveCount(0);
  await ready(page, '/admin/p/feedback/issues');
  await expect(page.getByText('此分区不可用')).toBeVisible();
});
