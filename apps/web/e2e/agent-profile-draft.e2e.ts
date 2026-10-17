import { expect, test } from '@playwright/test';
import type { AgentDetail } from '@greenhouse/contract';
import { apiAs } from './api';
import { open } from './fixtures';

test('Agent profile drafts survive canceled tab, link, Back and reload navigation', async ({ page, request }) => {
  const name = `Profile draft ${Date.now().toString(36)}`;
  const agent = await apiAs<AgentDetail>(request, 'lin', 'POST', '/api/agents', {
    name,
    instructions: 'Saved instructions',
  });
  await open(page, '/#/agents');
  await page.getByRole('link', { name: new RegExp(name) }).click();
  const instructions = page.getByRole('textbox', { name: '指令', exact: true });
  await instructions.fill('Saved instructions\nUnsaved research constraints');
  await page.getByRole('textbox', { name: '这次改了什么', exact: true }).fill('Draft note');
  const leave = page.getByRole('alertdialog', { name: '放弃未保存的更改？' });

  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await leave.getByRole('button', { name: '继续编辑' }).click();
  await expect(page.getByRole('tab', { name: '资料', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(instructions).toHaveValue('Saved instructions\nUnsaved research constraints');
  await expect(page.getByRole('textbox', { name: '这次改了什么', exact: true })).toHaveValue('Draft note');

  await page.getByRole('link', { name: '我的', exact: true }).click();
  await leave.getByRole('button', { name: '继续编辑' }).click();
  await expect(instructions).toHaveValue('Saved instructions\nUnsaved research constraints');

  await page.goBack();
  await leave.getByRole('button', { name: '继续编辑' }).click();
  await expect(instructions).toHaveValue('Saved instructions\nUnsaved research constraints');

  const reloadDialog = page.waitForEvent('dialog');
  // A canceled navigation has no load event to wait for.
  await page.evaluate(() => {
    setTimeout(() => location.reload(), 0);
  });
  const browserQuestion = await reloadDialog;
  expect(browserQuestion.type()).toBe('beforeunload');
  await browserQuestion.dismiss();
  await expect(instructions).toHaveValue('Saved instructions\nUnsaved research constraints');
  expect((await apiAs<AgentDetail>(request, 'lin', 'GET', `/api/agents/${agent.id}`)).instructions).toBe(
    'Saved instructions',
  );

  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await leave.getByRole('button', { name: '放弃更改', exact: true }).click();
  await expect(page.getByRole('tab', { name: '记忆', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: '资料', exact: true }).click();
  await expect(instructions).toHaveValue('Saved instructions');
  await expect(page.getByRole('status').filter({ hasText: '有未保存的更改' })).toHaveCount(0);
});

test('a failed profile save retains the draft and guard; successful retry releases both', async ({ page, request }) => {
  const agent = await apiAs<AgentDetail>(request, 'lin', 'POST', '/api/agents', {
    name: `Profile retry ${Date.now().toString(36)}`,
    instructions: 'Original profile',
  });
  await open(page, `/#/agents/${agent.id}`);
  const instructions = page.getByRole('textbox', { name: '指令', exact: true });
  await instructions.fill('Updated profile after retry');
  let attempts = 0;
  await page.route(`**/api/agents/${agent.id}`, async (route) => {
    if (route.request().method() === 'PATCH' && ++attempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'service_unavailable', message: 'Synthetic pre-commit failure' } }),
      });
    } else await route.continue();
  });

  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('form', { name: '资料' })).toHaveAttribute('aria-busy', 'false');
  await expect(instructions).toHaveValue('Updated profile after retry');
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '继续编辑' }).click();

  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('已保存为版本 2')).toBeVisible();
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await expect(page.getByRole('tab', { name: '记忆', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.getByRole('tab', { name: '资料', exact: true }).click();
  await expect(instructions).toHaveValue('Updated profile after retry');
  expect(attempts).toBe(2);
  expect((await apiAs<AgentDetail>(request, 'lin', 'GET', `/api/agents/${agent.id}`)).instructions).toBe(
    'Updated profile after retry',
  );
});
