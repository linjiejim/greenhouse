import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { Base, NeedsYou, Message } from '@greenhouse/contract';
import { apiAs } from './api';
import { composer, open } from './fixtures';

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
    await page.screenshot({ path: `${path}browser-${name}-${suffix}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}

async function conversation(request: Parameters<typeof apiAs>[0], name: string) {
  const agent = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/agents', { name });
  return apiAs<{ id: string }>(request, 'lin', 'POST', '/api/conversations', { kind: 'direct', agent_id: agent.id });
}

test('schema cards show named types and chips, reuse the primary field, and avoid duplicate directory subtitles', async ({
  page,
  request,
}) => {
  const thread = await conversation(request, 'T14 schema');
  await open(page, `/#/c/${thread.id}`);
  await composer(page).fill('acceptance schema');
  await composer(page).press('Enter');
  const details = page.locator('.app-request-details');
  await expect(details).toContainText('客户名');
  await expect(details).toContainText('文本 · 主字段');
  await expect(details.locator('.app-detail-chips')).toHaveText('新客户洽谈中');
  await expect(details).not.toContainText('single_select');
  await expect(page.getByRole('button', { name: /等你批准/ })).toBeVisible();
  await capture(page, 'schema');
  await page.getByRole('button', { name: '批准', exact: true }).click();
  await expect(page.getByRole('button', { name: /已完成：确认表格结构计划/ })).toBeVisible();
  const bases = await apiAs<{ items: Base[] }>(request, 'lin', 'GET', '/api/tables/bases');
  const base = await apiAs<Base>(
    request,
    'lin',
    'GET',
    `/api/tables/bases/${bases.items.find((b) => b.name === 'T14 browser customers')!.id}`,
  );
  expect(base.tables[0]!.fields.map((f) => f.name)).toEqual(['客户名', '阶段']);
  await open(page, '/#/tables');
  const row = page.locator('.app-list-row').filter({ hasText: 'T14 browser customers' });
  await expect(row).toContainText('T14 browser customers');
  await expect(row.locator('.app-list-meta')).toHaveCount(0);
});

test('knowledge cards safely preview Markdown, expand, and update the original step after rejection', async ({
  page,
  request,
}) => {
  const thread = await conversation(request, 'T14 knowledge');
  const folder = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/knowledge/folders', {
    name: 'T14 shared preview',
    space: 'team',
  });
  await open(page, `/#/c/${thread.id}`);
  await composer(page).fill(`acceptance markdown ${folder.id}`);
  await composer(page).press('Enter');
  const preview = page.locator('.app-markdown-preview');
  await expect(preview.locator('h1')).toHaveText('PG18 速览');
  await expect(preview.locator('strong')).toHaveText('异步 I/O');
  await expect(preview.locator('code').first()).toHaveText('EXPLAIN');
  await expect(preview.locator('img,script,input,iframe')).toHaveCount(0);
  expect(await page.evaluate(() => 'previewAttack' in window)).toBe(false);
  await expect(preview.locator('.is-clamped')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /等你批准/ })).toBeVisible();
  await capture(page, 'knowledge');
  await preview.getByRole('button', { name: '展开', exact: true }).click();
  await expect(preview.locator('.is-clamped')).toHaveCount(0);
  const cards = await apiAs<{ items: NeedsYou[] }>(request, 'lin', 'GET', `/api/requests?conversation_id=${thread.id}`);
  expect(cards.items[0]!.payload.details).toEqual(
    expect.arrayContaining([expect.objectContaining({ format: 'markdown' })]),
  );
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(page.getByRole('button', { name: /未执行：.*已拒绝/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /等你批准/ })).toHaveCount(0);
});

test('three same-turn record creations appear as one receipt with one atomic undo', async ({ page, request }) => {
  const base = await apiAs<Base>(request, 'lin', 'POST', '/api/tables/bases', { name: 'T14 receipts' });
  const table = base.tables[0]!;
  const thread = await conversation(request, 'T14 records');
  await open(page, `/#/c/${thread.id}`);
  await composer(page).fill(`acceptance records ${table.id} ${table.fields[0]!.id}`);
  await composer(page).press('Enter');
  await expect(page.getByText('Records completed.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '撤销这次写入' })).toHaveCount(1);
  await expect(page.getByText(/新增记录「深圳云图科技」/)).toBeVisible();
  const transcript = await apiAs<{ items: Message[] }>(
    request,
    'lin',
    'GET',
    `/api/conversations/${thread.id}/messages`,
  );
  expect(transcript.items.filter((m) => m.event?.type === 'write_receipt')).toHaveLength(1);
  await capture(page, 'receipts');
  await page.getByRole('button', { name: '撤销这次写入' }).click();
  await expect(page.getByRole('button', { name: '已撤销' })).toBeDisabled();
  expect(
    (await apiAs<{ items: unknown[] }>(request, 'lin', 'POST', `/api/tables/tables/${table.id}/records/query`, {}))
      .items,
  ).toHaveLength(0);
});
