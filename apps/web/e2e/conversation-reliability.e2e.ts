import { expect, test, type Page } from '@playwright/test';
import type { ConversationDetail, MessageItem, Page as PageResult } from '@greenhouse/contract';
import { apiAs } from './api';
import { composer, messageMenu, open } from './fixtures';

const messagesPath = /\/api\/conversations\/[^/]+\/messages(?:\?.*)?$/;

async function chooseAgent(page: Page, name: string) {
  await composer(page).fill('@');
  await page.getByRole('option', { name: new RegExp(name) }).click();
  await expect(page.locator('.app-chip', { hasText: `交给 ${name}` })).toBeVisible();
}

test('a branch copies the selected reply boundary and specialist, then continues without changing the source', async ({
  page,
  request,
}) => {
  const agent = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/agents', {
    name: 'Branch Researcher',
    instructions: 'Cite the supplied research evidence.',
  });
  const source = await apiAs<ConversationDetail>(request, 'lin', 'POST', '/api/conversations', {
    kind: 'chat',
    agent_id: agent.id,
  });
  await open(page, `/#/c/${source.id}`);
  const scope = 'BRANCH-SCOPE: 美国市场，预算 200 美元，排除大型产品。';
  await composer(page).fill(scope);
  await composer(page).press('Enter');
  await expect
    .poll(async () => {
      const result = await apiAs<PageResult<MessageItem>>(
        request,
        'lin',
        'GET',
        `/api/conversations/${source.id}/messages`,
      );
      return result.items.find((message) => message.role === 'assistant')?.status;
    })
    .toBe('complete');
  const first = await apiAs<PageResult<MessageItem>>(request, 'lin', 'GET', `/api/conversations/${source.id}/messages`);
  const boundary = first.items.find((message) => message.role === 'assistant')!;
  await composer(page).fill('LATER-SCOPE: 改成欧洲市场，预算 900 美元。');
  await composer(page).press('Enter');
  await expect
    .poll(async () => {
      const result = await apiAs<PageResult<MessageItem>>(
        request,
        'lin',
        'GET',
        `/api/conversations/${source.id}/messages`,
      );
      return result.items.filter((message) => message.role === 'assistant' && message.status === 'complete').length;
    })
    .toBe(2);
  const original = await apiAs<PageResult<MessageItem>>(
    request,
    'lin',
    'GET',
    `/api/conversations/${source.id}/messages`,
  );
  const createResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/conversations' && response.request().method() === 'POST',
  );
  const menu = await messageMenu(page.locator('.app-message').filter({ hasText: `Echo: ${scope}` }));
  await menu.getByRole('menuitem', { name: '从这里新开会话' }).click();
  const createdResponse = await createResponse;
  expect(createdResponse.status()).toBe(201);
  const branch = (await createdResponse.json()) as ConversationDetail;
  await expect(page).toHaveURL(new RegExp(`#/c/${branch.id}$`));
  expect(branch).toMatchObject({
    agent_id: agent.id,
    forked_from_message_id: boundary.id,
    last_seq: first.items.length,
  });
  const copied = await apiAs<PageResult<MessageItem>>(
    request,
    'lin',
    'GET',
    `/api/conversations/${branch.id}/messages`,
  );
  expect(copied.items.map((message) => message.content)).toEqual(first.items.map((message) => message.content));
  expect(copied.items.every((message) => !original.items.some((old) => old.id === message.id))).toBe(true);
  expect(copied.items.every((message) => message.run_id === null && message.steps.length === 0)).toBe(true);
  await expect(composer(page)).toHaveAttribute('placeholder', '给 Branch Researcher 发消息');
  await expect(page.locator('.app-message').filter({ hasText: 'LATER-SCOPE' })).toHaveCount(0);
  await composer(page).fill('BRANCH-FOLLOWUP: 继续这项研究。');
  await composer(page).press('Enter');
  await expect(page.getByText('Echo: BRANCH-FOLLOWUP: 继续这项研究。', { exact: true })).toBeVisible();
  // Fixture text only signals that the turn finished; these API assertions verify the business boundary.
  expect(
    await apiAs<PageResult<MessageItem>>(request, 'lin', 'GET', `/api/conversations/${source.id}/messages`),
  ).toEqual(original);
  const continued = await apiAs<PageResult<MessageItem>>(
    request,
    'lin',
    'GET',
    `/api/conversations/${branch.id}/messages`,
  );
  expect(continued.items.map((message) => message.content).join('\n')).toContain('BRANCH-SCOPE');
  expect(continued.items.map((message) => message.content).join('\n')).not.toContain('LATER-SCOPE');
});

test('a source deleted after the menu opens produces an error and never opens an empty fallback chat', async ({
  page,
  request,
}) => {
  const source = await apiAs<ConversationDetail>(request, 'lin', 'POST', '/api/conversations', { kind: 'chat' });
  await open(page, `/#/c/${source.id}`);
  await composer(page).fill('BRANCH-PERMISSION: use only the source I can still read.');
  await composer(page).press('Enter');
  const reply = page.locator('.app-message').filter({ hasText: 'Echo: BRANCH-PERMISSION' });
  const menu = await messageMenu(reply);
  let attempts = 0;
  await page.route('**/api/conversations', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts += 1;
    await apiAs(request, 'lin', 'DELETE', `/api/conversations/${source.id}`);
    await route.continue();
  });
  const response = page.waitForResponse(
    (item) => new URL(item.url()).pathname === '/api/conversations' && item.request().method() === 'POST',
  );
  await menu.getByRole('menuitem', { name: '从这里新开会话' }).click();
  expect((await response).status()).toBe(404);
  await expect(page.getByText('对象不存在或已无法访问，请刷新列表', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/c/${source.id}$`));
  expect(attempts).toBe(1);
});

test('a failed create and repeated first-message failures retry one successfully created chat', async ({
  page,
  request,
}) => {
  await open(page, '/#/c/new');
  let creates = 0;
  const created: ConversationDetail[] = [];
  const sendTargets: string[] = [];
  await page.route('**/api/conversations', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    creates += 1;
    if (creates === 1) {
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'internal', message: 'Injected pre-commit create failure' } }),
      });
    }
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    created.push((await response.json()) as ConversationDetail);
    await route.fulfill({ response });
  });
  await page.route(messagesPath, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sendTargets.push(new URL(route.request().url()).pathname.split('/')[3]!);
    if (sendTargets.length <= 2) {
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'internal', message: 'Injected pre-commit message failure' } }),
      });
    }
    await route.continue();
  });
  const draft = 'RETRY-SCOPE: 保留这个完整任务草稿，失败后继续。';
  await composer(page).fill(draft);
  for (let failure = 0; failure < 3; failure++) {
    const response = page.waitForResponse(
      (item) =>
        item.request().method() === 'POST' &&
        item.status() === 503 &&
        new URL(item.url()).pathname.startsWith('/api/conversations'),
    );
    await composer(page).press('Enter');
    await response;
    await expect(composer(page)).toHaveValue(draft);
    await expect(page).toHaveURL(/#\/c\/new$/);
  }
  expect(creates).toBe(2);
  expect(created).toHaveLength(1);
  expect(
    (await apiAs<PageResult<MessageItem>>(request, 'lin', 'GET', `/api/conversations/${created[0]!.id}/messages`))
      .items,
  ).toEqual([]);
  await composer(page).press('Enter');
  await expect(page).toHaveURL(new RegExp(`#/c/${created[0]!.id}$`));
  await expect(page.getByText(`Echo: ${draft}`, { exact: true })).toBeVisible();
  expect(creates).toBe(2);
  expect(sendTargets).toEqual([created[0]!.id, created[0]!.id, created[0]!.id]);
  const saved = await apiAs<PageResult<MessageItem>>(
    request,
    'lin',
    'GET',
    `/api/conversations/${created[0]!.id}/messages`,
  );
  expect(saved.items.filter((message) => message.role === 'user').map((message) => message.content)).toEqual([draft]);
});

test('failed pending chats are isolated by Agent and switching back reuses the original pending chat', async ({
  page,
  request,
}) => {
  const a = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/agents', { name: 'Retry Analyst A' });
  const b = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/agents', { name: 'Retry Analyst B' });
  await open(page, `/#/c/new?agent=${a.id}`);
  await expect(composer(page)).toHaveAttribute('placeholder', '给 Retry Analyst A 发消息');
  const created: ConversationDetail[] = [];
  const sendTargets: string[] = [];
  await page.route('**/api/conversations', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    created.push((await response.json()) as ConversationDetail);
    await route.fulfill({ response });
  });
  await page.route(messagesPath, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sendTargets.push(new URL(route.request().url()).pathname.split('/')[3]!);
    if (sendTargets.length <= 2)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'internal', message: 'Injected pre-commit message failure' } }),
      });
    await route.continue();
  });
  await composer(page).fill('Draft for A');
  await composer(page).press('Enter');
  await expect.poll(() => sendTargets.length).toBe(1);
  await expect(composer(page)).toHaveValue('Draft for A');
  await chooseAgent(page, 'Retry Analyst B');
  await composer(page).fill('Draft for B');
  await composer(page).press('Enter');
  await expect.poll(() => sendTargets.length).toBe(2);
  await expect(composer(page)).toHaveValue('Draft for B');
  await chooseAgent(page, 'Retry Analyst A');
  await composer(page).fill('Retry A with revised scope');
  await composer(page).press('Enter');
  await expect(page.getByText('Echo: Retry A with revised scope', { exact: true })).toBeVisible();
  expect(created).toHaveLength(2);
  expect(created.map((chat) => chat.agent_id)).toEqual([a.id, b.id]);
  expect(sendTargets).toEqual([created[0]!.id, created[1]!.id, created[0]!.id]);
  await expect(page).toHaveURL(new RegExp(`#/c/${created[0]!.id}$`));
  const savedA = await apiAs<PageResult<MessageItem>>(
    request,
    'lin',
    'GET',
    `/api/conversations/${created[0]!.id}/messages`,
  );
  const savedB = await apiAs<PageResult<MessageItem>>(
    request,
    'lin',
    'GET',
    `/api/conversations/${created[1]!.id}/messages`,
  );
  expect(savedA.items.filter((message) => message.role === 'user').map((message) => message.content)).toEqual([
    'Retry A with revised scope',
  ]);
  expect(savedB.items).toEqual([]);
});

test('a deleted pending chat is forgotten only after a missing-chat probe, and the next user send starts again', async ({
  page,
  request,
}) => {
  await open(page, '/#/c/new');
  const created: ConversationDetail[] = [];
  const sendTargets: string[] = [];
  await page.route('**/api/conversations', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    created.push((await response.json()) as ConversationDetail);
    await route.fulfill({ response });
  });
  await page.route(messagesPath, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sendTargets.push(new URL(route.request().url()).pathname.split('/')[3]!);
    if (sendTargets.length === 1)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'internal', message: 'Injected pre-commit message failure' } }),
      });
    await route.continue();
  });
  const draft = 'RECOVER-GONE: 保留任务，确认旧会话不存在后由我重试。';
  await composer(page).fill(draft);
  await composer(page).press('Enter');
  await expect.poll(() => sendTargets.length).toBe(1);
  await expect(composer(page)).toHaveValue(draft);
  expect(created).toHaveLength(1);
  const oldId = created[0]!.id;
  await apiAs(request, 'lin', 'DELETE', `/api/conversations/${oldId}`);
  const failedSend = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/conversations/${oldId}/messages`,
  );
  const checked = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/conversations/${oldId}`,
  );
  await composer(page).press('Enter');
  expect((await failedSend).status()).toBe(404);
  expect((await checked).status()).toBe(404);
  await expect(composer(page)).toHaveValue(draft);
  await expect(page).toHaveURL(/#\/c\/new$/);
  expect(created).toHaveLength(1); // No automatic create or resend in the failed attempt.
  await composer(page).press('Enter');
  await expect.poll(() => created.length).toBe(2);
  await expect(page).toHaveURL(new RegExp(`#/c/${created[1]!.id}$`));
  await expect(page.getByText(`Echo: ${draft}`, { exact: true })).toBeVisible();
  expect(sendTargets).toEqual([oldId, oldId, created[1]!.id]);
  expect(created[1]!.agent_id).toBe(created[0]!.agent_id);
  const saved = await apiAs<PageResult<MessageItem>>(
    request,
    'lin',
    'GET',
    `/api/conversations/${created[1]!.id}/messages`,
  );
  expect(saved.items.filter((message) => message.role === 'user').map((message) => message.content)).toEqual([draft]);
});

for (const probeStatus of [200, 503] as const) {
  test(`a message-level not_found keeps its pending chat when the conversation probe answers ${probeStatus}`, async ({
    page,
    request,
  }) => {
    await open(page, '/#/c/new');
    const created: ConversationDetail[] = [];
    const sendTargets: string[] = [];
    await page.route('**/api/conversations', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      created.push((await response.json()) as ConversationDetail);
      await route.fulfill({ response });
    });
    await page.route(messagesPath, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      sendTargets.push(new URL(route.request().url()).pathname.split('/')[3]!);
      if (sendTargets.length === 1)
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'not_found', message: 'The referenced attachment is missing.' } }),
        });
      await route.continue();
    });
    if (probeStatus === 503) {
      await page.route(/\/api\/conversations\/[^/]+$/, async (route) => {
        if (route.request().method() === 'GET' && sendTargets.length === 1) {
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              error: { code: 'internal', message: 'The conversation lookup is temporarily unavailable.' },
            }),
          });
        }
        await route.continue();
      });
    }
    const checked = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        /\/api\/conversations\/cnv_[^/]+$/.test(new URL(response.url()).pathname),
    );
    const draft = `KEEP-PENDING-${probeStatus}: 会话存在，不要因为附件或查询失败而换会话。`;
    await composer(page).fill(draft);
    await composer(page).press('Enter');
    expect((await checked).status()).toBe(probeStatus);
    await expect(composer(page)).toHaveValue(draft);
    expect(created).toHaveLength(1);
    // The independent API check confirms the conversation itself still exists in both cases.
    expect((await apiAs<ConversationDetail>(request, 'lin', 'GET', `/api/conversations/${created[0]!.id}`)).id).toBe(
      created[0]!.id,
    );
    await composer(page).press('Enter');
    await expect(page).toHaveURL(new RegExp(`#/c/${created[0]!.id}$`));
    await expect(page.getByText(`Echo: ${draft}`, { exact: true })).toBeVisible();
    expect(created).toHaveLength(1);
    expect(sendTargets).toEqual([created[0]!.id, created[0]!.id]);
  });
}
