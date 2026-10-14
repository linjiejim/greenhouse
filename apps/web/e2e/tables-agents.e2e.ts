import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { Base, Automation, Page as CursorPage, AutomationRun } from '@greenhouse/contract';
import { apiAs } from './api';
import { composer, open } from './fixtures';

const pictures = new URL('../../../artifacts/t6/', import.meta.url).pathname;
async function capture(page: Page, name: string) {
  mkdirSync(pictures, { recursive: true });
  for (const [suffix, theme, width] of [
    ['light', 'light', 1440],
    ['dark', 'dark', 1440],
    ['narrow', 'light', 390],
  ] as const) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await page.screenshot({ animations: 'disabled', path: `${pictures}${name}-${suffix}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test('a record can be given to an Agent and its result comes back as a comment', async ({ page, request }) => {
  const base = await apiAs<Base>(request, 'lin', 'POST', '/api/tables/bases', { name: 'T6 handoff' });
  const table = base.tables[0]!;
  const record = await apiAs<{ record: { id: string } }>(
    request,
    'lin',
    'POST',
    `/api/tables/tables/${table.id}/records`,
    { values: { [table.fields[0]!.id]: 'Review this record' } },
  );
  await open(page, `/#/tables/${base.id}/${table.id}?record=${record.record.id}`);
  await page.getByRole('button', { name: '交给 Agent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '交给 Agent', exact: true });
  await dialog.getByRole('textbox', { name: '简报' }).fill('Summarize this record');
  await capture(page, 'record-handoff');
  await dialog.getByRole('button', { name: '开始运行', exact: true }).click();
  await expect(page).toHaveURL(/#\/runs\/run_/);
  await expect(page.getByRole('main')).toContainText('表格');
  await expect
    .poll(async () =>
      JSON.stringify(await apiAs(request, 'lin', 'GET', `/api/tables/records/${record.record.id}/activity`)),
    )
    .toContain('Echo:');
});

test('build a notify automation and an Agent automation and inspect their history', async ({ page, request }) => {
  const base = await apiAs<Base>(request, 'lin', 'POST', '/api/tables/bases', { name: 'T6 automations' });
  const table = base.tables[0]!;
  await open(page, `/#/tables/${base.id}/${table.id}`);
  await page.getByRole('main').getByRole('button', { name: '更多', exact: true }).first().click();
  await page.getByRole('menuitem', { name: '自动化', exact: true }).click();
  await page.getByRole('button', { name: '新建自动化' }).click();
  let dialog = page.getByRole('dialog', { name: '编辑自动化' });
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('T6 notify');
  await dialog.getByRole('textbox', { name: '通知内容' }).fill('T6 record created');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '自动化', exact: true })).toContainText('T6 notify');
  await page.getByRole('button', { name: '新建自动化' }).click();
  dialog = page.getByRole('dialog', { name: '编辑自动化' });
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('T6 Agent step');
  await dialog.getByRole('combobox', { name: '执行动作' }).click();
  await page.getByRole('option', { name: 'Agent', exact: true }).click();
  await dialog.getByRole('textbox', { name: '简报' }).fill('Review the new record');
  await capture(page, 'automation-editor');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '自动化', exact: true })).toContainText('T6 Agent step');
  const rules = await apiAs<CursorPage<Automation>>(request, 'lin', 'GET', `/api/tables/bases/${base.id}/automations`);
  await apiAs(request, 'lin', 'POST', `/api/tables/tables/${table.id}/records`, {
    values: { [table.fields[0]!.id]: 'New source' },
  });
  const agent = rules.items.find((r) => r.name === 'T6 Agent step')!;
  await expect
    .poll(
      async () => {
        const run = (
          await apiAs<CursorPage<AutomationRun>>(request, 'lin', 'GET', `/api/tables/automations/${agent.id}/runs`)
        ).items[0];
        return run?.run_id ? run.status : 'queued';
      },
      { timeout: 15000 },
    )
    .toBe('succeeded');
  const notified = rules.items.find((r) => r.name === 'T6 notify')!;
  await expect
    .poll(
      async () =>
        (await apiAs<CursorPage<AutomationRun>>(request, 'lin', 'GET', `/api/tables/automations/${notified.id}/runs`))
          .items[0]?.status,
      { timeout: 15000 },
    )
    .toBe('succeeded');
  await page.getByRole('button', { name: '运行历史' }).last().click();
  await expect(page.getByRole('dialog', { name: '运行历史' })).toContainText('已完成');
  await capture(page, 'automation-history');
});

test('an Agent updates a shared table after approval and cited records open their drawer', async ({
  page,
  request,
}) => {
  const base = await apiAs<Base>(request, 'lin', 'POST', '/api/tables/bases', { name: 'T6 shared approvals' });
  const table = base.tables[0]!;
  const field = table.fields[0]!;
  const record = await apiAs<{ record: { id: string } }>(
    request,
    'lin',
    'POST',
    `/api/tables/tables/${table.id}/records`,
    { values: { [field.id]: 'Before approval' } },
  );
  const people = await apiAs<{ items: Array<{ id: string; name: string }> }>(request, 'lin', 'GET', '/api/members');
  await apiAs(request, 'lin', 'PUT', `/api/tables/bases/${base.id}/share`, {
    items: [{ type: 'member', id: people.items.find((p) => p.name === 'Mei')!.id, role: 'editor' }],
  });
  const agent = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/agents', { name: 'T6 table writer' });
  const thread = await apiAs<{ id: string }>(request, 'lin', 'POST', '/api/conversations', {
    kind: 'direct',
    agent_id: agent.id,
  });
  await open(page, `/#/c/${thread.id}`);
  await composer(page).fill(`change table record ${table.id} ${record.record.id} ${field.id}`);
  await composer(page).press('Enter');
  await expect(page.getByRole('button', { name: '批准', exact: true })).toBeVisible();
  await capture(page, 'shared-table-card');
  const before = await apiAs<{ record: { values: Record<string, unknown> } }>(
    request,
    'lin',
    'GET',
    `/api/tables/records/${record.record.id}`,
  );
  expect(before.record.values[field.id]).toBe('Before approval');
  await page.getByRole('button', { name: '批准', exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await apiAs<{ record: { values: Record<string, unknown> } }>(
            request,
            'lin',
            'GET',
            `/api/tables/records/${record.record.id}`,
          )
        ).record.values[field.id],
    )
    .toBe('Approved record');
  await expect(page.getByText('Done.', { exact: true })).toBeVisible();
  await expect(composer(page)).toBeEnabled();
  await composer(page).fill(`read table record ${record.record.id}`);
  await composer(page).press('Enter');
  await page.getByRole('button', { name: '查看来源：Approved record' }).click();
  await expect(page.getByRole('dialog', { name: 'Approved record' })).toBeVisible();
});
