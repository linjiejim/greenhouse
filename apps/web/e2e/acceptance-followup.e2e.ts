import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { AppDraft, Base, Field, MemberSummary, Message, RunView } from '@greenhouse/contract';
import { apiAs } from './api';
import { as, composer, open } from './fixtures';

async function capture(page: Page, name: string) {
  const path = new URL('../../../artifacts/t14/', import.meta.url).pathname;
  mkdirSync(path, { recursive: true });
  for (const [suffix, theme, width] of [
    ['light', 'light', 1440],
    ['dark', 'dark', 1440],
    ['narrow', 'light', 390],
  ] as const) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.screenshot({ path: `${path}browser-batch2-${name}-${suffix}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}

test('room drafts queue across delayed sends, pending mentions cannot send, and Mei sees Lin’s Agent face', async ({
  page,
  request,
  browser,
}) => {
  const people = await apiAs<{ items: MemberSummary[] }>(request, 'lin', 'GET', '/api/members');
  const mei = people.items.find((member) => member.name === 'Mei')!;
  const room = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/conversations', {
    kind: 'room',
    title: 'T14 一起讨论',
    member_ids: [mei.id],
    agent_ids: ['main'],
  });
  let releaseMembers!: () => void;
  const membersGate = new Promise<void>((resolve) => {
    releaseMembers = resolve;
  });
  await page.route(`**/api/conversations/${room.id}/members`, async (route) => {
    await membersGate;
    await route.continue();
  });
  await open(page, `/#/c/${room.id}`);
  await expect(page.getByText('@ 一个 Agent 让它回答', { exact: true })).toBeVisible();
  await page.locator('.app-composer-input').fill('@Me');
  await page.locator('.app-composer-input').press('Enter');
  await expect(page.locator('.app-composer-input')).toHaveValue('@Me');
  releaseMembers();
  await expect(page.getByRole('option', { name: /Mei/ })).toBeVisible();
  await page.locator('.app-composer-input').press('Enter');
  await expect(page.locator('.app-composer-input')).toHaveValue('@Mei ');
  await expect(page.locator('.app-room-roster')).toContainText('Greeny · Lin');
  await capture(page, 'room');
  let releaseSend!: () => void;
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const posts: string[] = [];
  await page.route(`**/api/conversations/${room.id}/messages`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts.push(route.request().postDataJSON().content);
    if (posts.length === 1) {
      const response = await route.fetch();
      await sendGate;
      return route.fulfill({ response });
    }
    await route.continue();
  });
  await page.locator('.app-composer-input').fill('@Greeny 先看一下');
  await page.locator('.app-composer-input').press('Enter');
  await expect.poll(() => posts.length).toBe(1);
  await page.locator('.app-composer-input').fill('你也看一下');
  await page.locator('.app-composer-input').press('Enter');
  await page.locator('.app-composer-input').fill('尚未发送的新草稿');
  expect(posts).toHaveLength(1);
  releaseSend();
  await expect.poll(() => posts.length).toBe(2);
  await expect(page.locator('.app-composer-input')).toHaveValue('尚未发送的新草稿');
  await expect
    .poll(async () =>
      (await apiAs<{ items: Message[] }>(request, 'lin', 'GET', `/api/conversations/${room.id}/messages`)).items
        .filter((message) => message.role === 'user')
        .map((message) => message.content),
    )
    .toEqual(['@Greeny 先看一下', '你也看一下']);
  const meiContext = await browser.newContext({ storageState: as('mei') });
  try {
    const meiPage = await meiContext.newPage();
    await open(meiPage, `/#/c/${room.id}`);
    await expect(meiPage.locator('.app-message').filter({ hasText: 'Greeny · Lin' }).first()).toBeVisible();
    await expect(
      meiPage.locator('.app-message').filter({ hasText: 'Greeny · Lin' }).first().locator('svg').first(),
    ).toBeVisible();
    await capture(meiPage, 'room-agent');
  } finally {
    await meiContext.close();
  }
});

test('published apps show version and pending edits, expose Open, and format wrapping record fields', async ({
  page,
  request,
}) => {
  const base = await apiAs<Base>(request, 'lin', 'POST', '/api/tables/bases', { name: 'T14 应用客户' });
  const table = base.tables[0]!;
  const stage = await apiAs<Field>(request, 'lin', 'POST', `/api/tables/tables/${table.id}/fields`, {
    name: '阶段',
    type: 'text',
  });
  const amount = await apiAs<Field>(request, 'lin', 'POST', `/api/tables/tables/${table.id}/fields`, {
    name: '金额',
    type: 'number',
    config: { currency: 'CNY', precision: 2 },
  });
  await apiAs(request, 'lin', 'POST', `/api/tables/tables/${table.id}/records`, {
    values: {
      [table.fields[0]!.id]: '深圳云图科技',
      [stage.id]: '正在商谈，下一步确认需求和报价',
      [amount.id]: 12345.5,
    },
  });
  let app = await apiAs<AppDraft>(request, 'lin', 'POST', '/api/apps', { name: 'T14 客户应用', base_id: base.id });
  app = await apiAs<AppDraft>(request, 'lin', 'PUT', `/api/apps/${app.app.id}/draft`, {
    revision: app.revision,
    name: app.app.name,
    description: '',
    spec: {
      roles: [],
      pages: [
        {
          id: 'home',
          name: '客户',
          cards: [
            {
              id: 'customers',
              kind: 'records',
              title: '客户列表',
              table_id: table.id,
              fields: table.fields.map((field) => field.id).concat(stage.id, amount.id),
              actions: [],
            },
          ],
        },
      ],
    },
  });
  await open(page, `/#/apps/${app.app.id}/edit`);
  await page.getByRole('button', { name: '发布应用', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '确认发布' });
  await expect(dialog).toContainText('新增 1 个页面');
  await expect(dialog).toContainText('未选择受众');
  await expect(dialog).not.toContainText('页面: +');
  await capture(page, 'publish-dialog');
  await dialog.getByRole('button', { name: '发布应用', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.app-page-header')).toContainText('已发布 · v1');
  await expect(page.locator('.app-page-header').getByRole('button', { name: '打开应用', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '页面名称', exact: true }).fill('客户进展');
  await expect(page.locator('.app-page-header')).toContainText('有未发布的修改');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.reload();
  await expect(page.locator('.app-page-header')).toContainText('有未发布的修改');
  await capture(page, 'builder');
  await page.locator('.app-page-header').getByRole('button', { name: '打开应用', exact: true }).click();
  const record = page.locator('.app-ap-record').first();
  await expect(record).toContainText('深圳云图科技');
  await expect(record).toContainText('12,345.50');
  await expect(record.locator('dt')).toHaveText(['阶段', '金额']);
  const titleBox = await record.locator('.app-ap-record-title').boundingBox();
  const fieldBox = await record.locator('dt').first().boundingBox();
  expect(Math.abs(titleBox!.x - fieldBox!.x)).toBeLessThan(2);
  await capture(page, 'runtime');
});

test('retried failures retain the cause and show a neutral successful recovery', async ({ page, request }) => {
  const base = await apiAs<Base>(request, 'lin', 'POST', '/api/tables/bases', { name: 'T14 重试' });
  const table = base.tables[0]!;
  const stage = await apiAs<Field>(request, 'lin', 'POST', `/api/tables/tables/${table.id}/fields`, {
    name: '阶段',
    type: 'single_select',
    config: { options: [{ id: 'new', label: '新客户', color: 'blue' }] },
  });
  const thread = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/conversations', { kind: 'chat' });
  await open(page, `/#/c/${thread.id}`);
  await composer(page).fill(`acceptance retry ${table.id} ${stage.id}`);
  await composer(page).press('Enter');
  await expect(page.getByText('Retry completed.', { exact: true })).toBeVisible();
  await expect(page.getByText('1 步失败后重试成功', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /新增表格记录失败/ }).click();
  await expect(page.locator('.app-step-summary').first()).toHaveText('新增表格记录失败：字段「阶段」没有这个选项');
  await capture(page, 'retried');
});

test('empty active runs offer finished runs and the latest results even on a narrow screen', async ({
  page,
  request,
}) => {
  const thread = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/conversations', { kind: 'chat' });
  await open(page, `/#/c/${thread.id}`);
  await composer(page).fill('acceptance background');
  await composer(page).press('Enter');
  await expect(page.getByText(/使用搜索和网页阅读 · 研究网站/)).toBeVisible();
  await page.getByRole('button', { name: '开始运行', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await apiAs<{ items: RunView[] }>(request, 'lin', 'GET', '/api/runs?state=done')).items.some(
          (run) => run.title === 'T14 后台比较',
        ),
      { timeout: 15000 },
    )
    .toBe(true);
  await open(page, '/#/runs');
  await expect(page.getByRole('link', { name: '查看已结束的运行' })).toBeVisible();
  await expect(page.getByText('T14 后台比较', { exact: true })).toBeVisible();
  await capture(page, 'finished');
  await page.getByRole('link', { name: '查看已结束的运行' }).click();
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toHaveText('已结束');
});

test('a live approval switches the Agent header to awaiting confirmation after the turn settles', async ({
  page,
  request,
}) => {
  const agent = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/agents', { name: 'T14 等待状态' });
  const thread = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/conversations', {
    kind: 'direct',
    agent_id: agent.id,
  });
  await open(page, `/#/c/${thread.id}`);
  await composer(page).fill('acceptance schema');
  await composer(page).press('Enter');
  await expect(page.locator('.app-request-details')).toBeVisible();
  await expect(page.locator('.app-title-status')).toHaveText('等你确认');
  await capture(page, 'awaiting');
});
