import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { API_BASE as API } from '../../playwright.client.config';
const REPLY = '两条都写在远程办公政策里：居家补贴一次性 1,000 美元，每月 75 美元。核心工时为工作日 10:00–14:00。';
async function auth(page: import('@playwright/test').Page) {
  await page.goto('/');
  await expect(page.getByTestId('composer-input')).toBeVisible();
  return page.evaluate(
    () => Object.entries(localStorage).find(([key]) => key.startsWith('greenhouse_access_token__'))?.[1] ?? '',
  );
}
test('home → new conversation → streamed reply; screenshots at every breakpoint', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const token = await auth(page);
  const headers = { Authorization: `Bearer ${token}` };
  const created: string[] = [];
  let session = '';
  try {
    for (const title of ['居家补贴和核心工时', 'A-1001 发货状态', '10 月亚马逊广告复盘']) {
      const response = await request.post(`${API}/api/sessions`, { headers, data: { title } });
      expect(response.ok()).toBeTruthy();
      created.push((await response.json()).id);
    }
    let sent = false;
    let text = '';
    // Keep POST /sessions real and track its id before the client receives it,
    // so cleanup also covers a failure before the first chat request.
    await page.route('**/api/sessions', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const response = await route.fetch();
      if (response.ok()) {
        const body = await response.json();
        if (typeof body.id === 'string') created.push(body.id);
      }
      await route.fulfill({ response });
    });
    // Same NDJSON text-delta / finish protocol as tests/e2e-ui/chat.spec.ts. The API and login remain real.
    await page.route('**/api/chat', async (route) => {
      const body = route.request().postDataJSON();
      sent = true;
      session = body.session_id;
      text = body.messages[0].content;
      await route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body:
          [
            { type: 'text-delta', text: REPLY.slice(0, 22) },
            { type: 'text-delta', text: REPLY.slice(22) },
            { type: 'finish', finishReason: 'stop' },
          ]
            .map((x) => JSON.stringify(x))
            .join('\n') + '\n',
      });
    });
    await page.route(/\/api\/sessions\/[^/?]+\/messages(?:\?.*)?$/, async (route) => {
      if (!sent) return route.fallback();
      const id = new URL(route.request().url()).pathname.split('/').at(-2);
      if (id !== session) return route.fallback();
      const message = (role: string, content: string, seq: number) => ({
        id: `c1-message-${seq}`,
        session_id: id,
        role,
        content,
        parts: {},
        pipeline: null,
        images: null,
        references_: null,
        created_at: new Date().toISOString(),
        seq,
      });
      await route.fulfill({
        json: {
          messages: [message('user', text, 1), message('assistant', REPLY, 2)],
          has_more: false,
          next_before_seq: null,
        },
      });
    });
    mkdirSync('tests/client-e2e/__screenshots__', { recursive: true });
    for (const width of [1440, 1280, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto('/');
      await expect(page.getByTestId('composer-input')).toBeVisible();
      if (width >= 760) {
        await expect(page.getByTestId('client-rail')).toBeVisible();
        if (width === 1024) await expect(page.getByTestId('client-secondary')).toBeHidden();
        else await expect(page.getByTestId('client-secondary')).toBeVisible();
      } else await expect(page.getByTestId('client-rail')).toBeHidden();
      await page.screenshot({ path: `tests/client-e2e/__screenshots__/home-${width}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId('composer-input').fill('居家补贴多少？核心工时呢？');
    await page.getByTestId('composer-input').press('Enter');
    await expect(page.getByText(REPLY, { exact: true })).toBeVisible();
    for (const width of [1440, 1280, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await expect(page.getByText(REPLY, { exact: true })).toBeVisible();
      await page.screenshot({ path: `tests/client-e2e/__screenshots__/chat-${width}.png` });
    }
    expect(errors).toEqual([]);
  } finally {
    if (session) created.push(session);
    for (const id of new Set(created)) await request.delete(`${API}/api/sessions/${id}`, { headers });
  }
});
test('rail navigation, collapsing sidebar and dark appearance', async ({ page }) => {
  await auth(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId('rail-drive').click();
  await expect(page).toHaveURL(/\/drive/);
  await page.getByTestId('rail-chat').click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.keyboard.press('Meta+\\');
  await expect(page.getByTestId('client-secondary')).toBeVisible();
  await page.keyboard.press('Meta+\\');
  await expect(page.getByTestId('client-secondary')).toBeHidden();
  await page.evaluate(() => localStorage.setItem('greenhouse_pref_theme', 'dark'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'tests/client-e2e/__screenshots__/home-dark.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('client-rail')).toBeHidden();
  await page.getByRole('button', { name: '侧边栏' }).click();
  await expect(page.getByText('云盘', { exact: true })).toBeVisible();
});
test('v2 manifest hides inactive places and keeps future pages reachable', async ({ page }) => {
  await page.route('**/api/extensions', (route) =>
    route.fulfill({
      json: {
        manifest_version: 2,
        core: { version: '4.0.0', client_api: 4 },
        extensions: [],
        entityKinds: [],
        plugins: [
          {
            id: 'crm',
            name: 'CRM',
            version: '1',
            official: false,
            features: [],
            mcp_groups: [],
            entities: [],
            entity_kinds: [],
            nav: [{ id: 'crm', label: '客户', icon: 'Building2', page: 'future', placement: 'more' }],
            pages: [{ id: 'future', title: '客户', kind: 'future', fallback_url: '/classic/#/crm' }],
          },
        ],
      },
    }),
  );
  await auth(page);
  await expect(page.getByTestId('rail-knowledge')).toHaveCount(0);
  await expect(page.getByTestId('rail-projects')).toHaveCount(0);
  await expect(page.getByTestId('rail-apps-divider')).toBeVisible();
  // apps live under the rail's More: hovering opens the flyout, leaving closes it
  await expect(page.getByTestId('rail-crm')).toHaveCount(0);
  await page.getByTestId('rail-more').hover();
  await expect(page.getByTestId('rail-more-menu')).toBeVisible();
  await page.getByTestId('rail-crm').click();
  await expect(page.getByTestId('rail-more-menu')).toHaveCount(0);
  await expect(page.getByText('此客户端不支持，在浏览器打开', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '在浏览器打开', exact: true })).toBeVisible();
});
