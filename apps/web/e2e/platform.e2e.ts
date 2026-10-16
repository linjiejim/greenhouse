import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { AgentDetail, Base } from '@greenhouse/contract';
import { apiAs } from './api';
import { as, composer, open } from './fixtures';

const screenshots = fileURLToPath(new URL('../../../artifacts/t11/', import.meta.url));

test('extensions: pages, search, personal/admin settings and entity panels use the enabled seam', async ({
  page,
  request,
  browser,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await open(page, '/#/ext/example/notes');
  await page.getByLabel('标题', { exact: true }).fill('T11 extension memo');
  await page.getByRole('button', { name: '添加笔记' }).click();
  const memo = page.getByRole('main').getByRole('link', { name: 'T11 extension memo' });
  await expect(memo).toBeVisible();
  await memo.click();
  await expect(page.getByRole('region', { name: '相关笔记' })).toContainText('T11 extension memo');
  await page.goto('/#/settings/ext/example/preferences');
  await page.getByLabel('显示名称').fill('T11 personal label');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect
    .poll(async () => (await apiAs<{ label: string }>(request, 'lin', 'GET', '/api/ext/example/settings')).label)
    .toBe('T11 personal label');
  await page.goto('/#/admin/ext/example/preferences');
  await page.getByLabel('显示名称').fill('T11 workspace label');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect
    .poll(async () => (await apiAs<{ label: string }>(request, 'lin', 'GET', '/api/ext/example/admin/settings')).label)
    .toBe('T11 workspace label');
  const doc = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/knowledge/docs', {
    title: 'T11 extension panel document',
    space: 'personal',
    content: 'Panel host.',
  });
  await page.goto(`/#/knowledge/${doc.id}`);
  await expect(page.getByRole('region', { name: '相关笔记' })).toContainText('T11 extension memo');
  await page.keyboard.press('Meta+k');
  const palette = page.getByRole('dialog');
  await palette.getByRole('combobox').fill('T11 extension memo');
  await expect(palette.getByRole('option', { name: /T11 extension memo/ })).toBeVisible();
  await palette.getByRole('option', { name: /T11 extension memo/ }).click();
  await expect(page).toHaveURL(/#\/ext\/example\/notes\/nte_/);
  const member = await browser.newContext({ storageState: as('mei') });
  try {
    const memberPage = await member.newPage();
    await memberPage.goto('/#/admin/ext/example/preferences');
    await expect(memberPage.getByLabel('显示名称')).toHaveCount(0);
  } finally {
    await member.close();
  }
  expect(errors).toEqual([]);
});

test('published Agent budgets: owner edits the limit and an audience call stops at the shared budget', async ({
  page,
  request,
  browser,
}) => {
  const agent = await apiAs<AgentDetail>(request, 'lin', 'POST', '/api/agents', { name: 'T11 budget Agent' });
  await apiAs(request, 'lin', 'PUT', `/api/agents/${agent.id}/publication`, { audience: [{ type: 'workspace' }] });
  await open(page, `/#/agents/${agent.id}?tab=publish`);
  const budget = page.getByRole('region', { name: 'Agent 月度预算' });
  await budget.getByLabel('每月上限').fill('1');
  await page.getByRole('tab', { name: '用量与活动', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
  await expect(budget.getByLabel('每月上限')).toHaveValue('1');
  await budget.getByRole('button', { name: '保存', exact: true }).click();
  await expect(budget.getByRole('meter')).toHaveAttribute('aria-valuemax', '1');
  const conversation = await apiAs<{ id: string }>(request, 'mei', 'POST', '/api/conversations', {
    kind: 'direct',
    agent_id: agent.id,
  });
  // One metered reply may cross the limit; the next is refused before its call.
  await apiAs(request, 'mei', 'POST', `/api/conversations/${conversation.id}/messages`, {
    content: 'First budget reply',
  });
  await expect
    .poll(
      async () =>
        (
          await apiAs<{ items: { working: boolean; id: string }[] }>(request, 'mei', 'GET', '/api/conversations')
        ).items.find((c) => c.id === conversation.id)?.working,
    )
    .toBe(false);
  const member = await browser.newContext({ storageState: as('mei') });
  try {
    const memberPage = await member.newPage();
    await open(memberPage, `/#/c/${conversation.id}`);
    await composer(memberPage).fill('Second budget reply');
    await composer(memberPage).press('Enter');
    await expect(memberPage.getByText('本月的用量预算已经用完了，请联系管理员。', { exact: true })).toBeVisible();
  } finally {
    await member.close();
  }
});

test('all seven module directories filter their own entries and support arrows, Enter and Escape', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  const name = 'T11Filter';
  await apiAs(request, 'lin', 'POST', '/api/agents', { name: name + 'Agent' });
  await apiAs(request, 'lin', 'POST', '/api/conversations', { kind: 'chat', title: name + 'Conversation' });
  await apiAs(request, 'lin', 'POST', '/api/knowledge/docs', { title: name, space: 'team' });
  const base = await apiAs<Base>(request, 'lin', 'POST', '/api/tables/bases', { name });
  await apiAs(request, 'lin', 'POST', '/api/apps', { name, base_id: base.id });
  await apiAs(request, 'lin', 'POST', '/api/skills', {
    kind: 'template',
    name: 't11filter',
    description: 'T11 filter',
    body: 'Read the brief.',
  });
  const main = await apiAs<{ id: string }>(request, 'lin', 'GET', '/api/agents/main');
  await apiAs(request, 'lin', 'PATCH', '/api/admin/operations', { pause_background_runs: true });
  const schedule = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/schedules', {
    agent_id: main.id,
    name,
    brief: 'Read the brief.',
    cron: '0 9 * * 1',
  });
  try {
    await apiAs(request, 'lin', 'POST', `/api/schedules/${schedule.id}/run-now`);
    for (const path of [
      '/#/c/main',
      '/#/agents',
      '/#/knowledge?space=team',
      '/#/tables',
      '/#/apps',
      '/#/skills',
      '/#/runs',
    ]) {
      await open(page, path);
      const directory = page.getByRole('complementary', { name: '目录' });
      await directory.getByRole('button', { name: /^搜索/ }).click();
      const search = directory.getByRole('textbox');
      const query = path.includes('/c/main') ? 't11filterconversation' : 't11filter';
      await search.fill(query);
      const result = directory
        .locator('a.app-row, button.app-row')
        .filter({ hasText: /t11filter/i })
        .first();
      await expect(result).toBeVisible();
      // Hover tips consume Escape first; keep the pointer clear for this keyboard-only check.
      await page.mouse.move(0, 0);
      await search.press('ArrowDown');
      await expect(directory.locator('.app-row:focus')).toBeVisible();
      // A truncated row shows its full name on keyboard focus; the first Escape closes that tip (WCAG 1.4.13).
      const tip = page.getByRole('tooltip');
      if (await tip.isVisible()) {
        await page.keyboard.press('Escape');
        await expect(tip).toBeHidden();
      }
      await page.keyboard.press('Escape');
      await expect(search).toBeFocused();
      await search.press('Escape');
      await expect(search).toHaveValue('');
      await search.fill(query);
      const target = (await result.getAttribute('href')) ?? `#/tables/${base.id}`;
      await search.press('Enter');
      // Enter follows the first visible row (trees may start with their matching parent).
      await expect(page).toHaveURL(new RegExp((target ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  } finally {
    await apiAs(request, 'lin', 'PATCH', '/api/admin/operations', { pause_background_runs: false });
    await apiAs(request, 'lin', 'DELETE', `/api/schedules/${schedule.id}`);
  }
});

test('operations and new surfaces render in light, dark and at 390 px without horizontal overflow', async ({
  page,
  request,
}) => {
  await mkdir(screenshots, { recursive: true });
  await apiAs(request, 'lin', 'POST', '/api/skills', {
    kind: 'template',
    name: 't11-visual-filter',
    description: 'Visual filter',
    body: 'Read the brief.',
  });
  const agent = await apiAs<AgentDetail>(request, 'lin', 'POST', '/api/agents', { name: 'T11 visual budget' });
  await apiAs(request, 'lin', 'PUT', `/api/agents/${agent.id}/publication`, { audience: [{ type: 'workspace' }] });
  await apiAs(request, 'lin', 'PUT', `/api/agents/${agent.id}/budgets`, { unit: 'tokens', monthly_limit: 100000 });
  try {
    await open(page, '/#/admin/operations');
    const computers = page.getByRole('switch', { name: '禁用电脑', exact: true });
    await computers.click();
    await expect(computers).toBeChecked();
    await page.reload();
    await expect(computers).toBeChecked();
    for (const [view, width, theme] of [
      ['light', 1440, 'light'],
      ['dark', 1440, 'dark'],
      ['narrow', 390, 'dark'],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      for (const [surface, path] of [
        ['operations', '/#/admin/operations'],
        ['extension', '/#/ext/example/notes'],
        ['budget', `/#/agents/${agent.id}?tab=publish`],
        ['directory', '/#/skills'],
        ['admin-budget', '/#/admin/public-agents'],
      ] as const) {
        await open(page, path);
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        if (surface === 'budget') await expect(page.getByRole('region', { name: 'Agent 月度预算' })).toBeVisible();
        if (surface === 'directory') {
          if (width === 390) await page.getByRole('button', { name: '菜单', exact: true }).click();
          const directory = page.getByRole('complementary', { name: '目录' });
          await directory.getByRole('button', { name: '搜索技能', exact: true }).click();
          await directory.getByRole('textbox').fill('t11-visual');
          await expect(directory.getByRole('link', { name: 't11-visual-filter' })).toBeVisible();
        }
        if (surface === 'admin-budget') {
          await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await page.screenshot({ path: `${screenshots}/public-agents-${view}.png`, fullPage: true });
          await page.getByRole('button', { name: '本月预算', exact: true }).first().click();
          await expect(page.getByRole('dialog', { name: 'Agent 月度预算' })).toBeVisible();
        }

        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (surface === 'budget')
          await page
            .getByRole('region', { name: 'Agent 月度预算' })
            .screenshot({ path: `${screenshots}/budget-panel-${view}.png` });
        await page.screenshot({ path: `${screenshots}/${surface}-${view}.png`, fullPage: true });
      }
    }
  } finally {
    await apiAs(request, 'lin', 'PATCH', '/api/admin/operations', { disable_computers: false });
  }
});
