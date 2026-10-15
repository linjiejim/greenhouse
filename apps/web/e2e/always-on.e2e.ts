import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { apiAs } from './api';
import { composer, open } from './fixtures';

// Screenshots for review go with the other test output, never into the repo.
const pictures = new URL('../test-results/screens/', import.meta.url).pathname;

test('background receipts do not hide a waiting card and approval resumes the run', async ({ page, request }) => {
  const agent = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/agents', { name: 'AO background' });
  const thread = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/conversations', {
    kind: 'direct',
    agent_id: agent.id,
  });
  const folder = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/knowledge/folders', {
    name: 'AO background shared',
    space: 'team',
  });
  await open(page, `/#/c/${thread.id}`);
  await composer(page).fill(`background draft in ${folder.id}`);
  await composer(page).press('Enter');
  await page.getByRole('button', { name: '开始运行', exact: true }).click();
  await expect(page.getByRole('button', { name: '撤销这次写入' })).toBeVisible();
  await expect(page.getByRole('button', { name: '批准', exact: true })).toBeVisible();
  mkdirSync(pictures, { recursive: true });
  for (const [name, theme, width] of [
    ['background-card-light', 'light', 1440],
    ['background-card-dark', 'dark', 1440],
    ['background-card-narrow', 'light', 390],
  ] as const) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${pictures}${name}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.getByRole('button', { name: '批准', exact: true }).click();
  await expect(page.getByText('Background finished.')).toBeVisible();
  await apiAs(request, 'lin', 'PATCH', `/api/conversations/${thread.id}`, { archived: true });
  await apiAs(request, 'lin', 'DELETE', `/api/agents/${agent.id}`);
});

test('private writes show receipts and can be undone, in light, dark and narrow screens', async ({ page, request }) => {
  const agent = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/agents', { name: 'AO receipt' });
  const thread = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/conversations', {
    kind: 'direct',
    agent_id: agent.id,
  });
  await open(page, `/#/c/${thread.id}`);
  await composer(page).fill('keep a note always-on receipt');
  await composer(page).press('Enter');
  await expect(page.getByRole('button', { name: '撤销这次写入' }).last()).toBeVisible();
  mkdirSync(pictures, { recursive: true });
  for (const [name, theme, width] of [
    ['receipt-light', 'light', 1440],
    ['receipt-dark', 'dark', 1440],
    ['receipt-narrow', 'light', 390],
  ] as const) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${pictures}${name}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.getByRole('button', { name: '撤销这次写入' }).last().click();
  await expect(page.getByRole('button', { name: '已撤销' }).last()).toBeDisabled();
  await apiAs(request, 'lin', 'PATCH', `/api/conversations/${thread.id}`, { archived: true });
  await apiAs(request, 'lin', 'DELETE', `/api/agents/${agent.id}`);
});

test('a shared card grants an exact folder scope and its Agent abilities can revoke it', async ({ page, request }) => {
  const folder = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/knowledge/folders', {
    name: 'Always-on approvals',
    space: 'team',
  });
  const agent = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/agents', { name: 'AO approvals' });
  const thread = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/conversations', {
    kind: 'direct',
    agent_id: agent.id,
  });
  await open(page, `/#/c/${thread.id}`);
  await composer(page).fill(`shared draft in ${folder.id}`);
  await composer(page).press('Enter');
  const allow = page.getByRole('switch', { name: '以后这个文件夹都允许' });
  await expect(allow).toBeVisible();
  const cards = await apiAs<{ items: { payload: { summary: string; details: unknown } }[] }>(
    request,
    'lin',
    'GET',
    '/api/requests?state=pending',
  );
  const card = cards.items.find((item) => JSON.stringify(item.payload.details).includes('shared draft in'))!;
  expect(card).toBeTruthy();
  expect(JSON.stringify([card.payload.summary, card.payload.details])).not.toMatch(
    /\b[a-z]{3}_[0-9A-HJKMNP-TV-Z]{26}\b/,
  );
  await expect(page.locator('.app-request-details')).toContainText('shared draft in Always-on approvals');
  mkdirSync(pictures, { recursive: true });
  await page.screenshot({ path: `${pictures}named-approval.png`, fullPage: true });

  await expect(page.getByText('以后这个文件夹都允许', { exact: true })).toBeVisible();
  await allow.click();
  await page.getByRole('button', { name: '批准', exact: true }).last().click();
  await expect(allow).not.toBeVisible();
  await page.goto(`/#/agents/${agent.id}?tab=abilities`);
  const approvals = page.getByRole('region', { name: '预先授权' });
  await expect(approvals.getByRole('button', { name: '撤销授权' })).toBeVisible();
  mkdirSync(pictures, { recursive: true });
  await page.screenshot({ path: `${pictures}standing-approvals.png`, fullPage: true });
  await approvals.getByRole('button', { name: '撤销授权' }).click();
  await expect(approvals.getByText('还没有预先授权')).toBeVisible();
  await apiAs(request, 'lin', 'PATCH', `/api/conversations/${thread.id}`, { archived: true });
  await apiAs(request, 'lin', 'DELETE', `/api/agents/${agent.id}`);
});

test('the quiet schedule switch defaults off and persists when saved and edited', async ({ page, request }) => {
  await open(page, '/#/agents/main?tab=schedules');
  await page.getByRole('button', { name: '新建定时' }).click();
  const dialog = page.getByRole('dialog', { name: '新建定时' });
  await dialog.getByLabel('名字').fill('Always-on quiet watch');
  await dialog.getByLabel('简报').fill('Watch for changes.');
  const quiet = dialog.getByRole('switch', { name: '没有发现时不通知' });
  await expect(quiet).not.toBeChecked();
  await expect(dialog.getByText('没有发现时不通知', { exact: true })).toBeVisible();
  await quiet.click();
  mkdirSync(pictures, { recursive: true });
  await page.screenshot({ path: `${pictures}quiet-schedule.png`, fullPage: true });
  await dialog.getByRole('button', { name: '创建定时' }).click();
  await page.getByRole('button', { name: /Always-on quiet watch/ }).click();
  await expect(page.getByRole('dialog').getByRole('switch', { name: '没有发现时不通知' })).toBeChecked();
  await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
  const schedules = await apiAs<{ items: Array<{ id: string; name: string }> }>(
    request,
    'lin',
    'GET',
    '/api/schedules',
  );
  await apiAs(
    request,
    'lin',
    'DELETE',
    `/api/schedules/${schedules.items.find((item) => item.name === 'Always-on quiet watch')!.id}`,
  );
});
