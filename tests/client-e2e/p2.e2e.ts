import { expect, test } from '@playwright/test';
import { installStation, shot } from './p2-fixture';
async function ready(page: import('@playwright/test').Page, path = '/') {
  await page.goto(path);
  await expect(page.getByTestId('startup-splash')).toHaveCount(0);
  await expect(page.getByTestId('composer-input').filter({ visible: true })).toBeVisible();
}
async function policy(page: import('@playwright/test').Page) {
  await ready(page, '/chat?session=policy-chat');
  await expect(page.getByText('核心工时', { exact: true })).toBeVisible();
}
async function openPolicy(page: import('@playwright/test').Page) {
  await page.getByTestId('client-main').getByRole('link', { name: '远程办公政策', exact: true }).first().click();
  await expect(page.getByTestId('client-inspector').filter({ visible: true })).toBeVisible();
}

test('P2 send, incremental stream, stop, regenerate, ask_user and dropped attachment', async ({ page }) => {
  const fixture = await installStation(page);
  const warnings: string[] = [];
  page.on('pageerror', (e) => warnings.push(e.message));
  page.on('console', (m) => {
    if (/non-boolean attribute|React does not recognize/i.test(m.text())) warnings.push(m.text());
  });
  await ready(page);
  await page.getByTestId('composer-input').filter({ visible: true }).fill('长回复');
  await page.getByTestId('composer-input').filter({ visible: true }).press('Enter');
  await expect(page.getByText('正在生成', { exact: true })).toBeVisible();
  await expect(page.getByTestId('composer-stop').filter({ visible: true })).toBeVisible();
  await page.getByTestId('composer-stop').filter({ visible: true }).click();
  await expect(page.getByTestId('composer-stop').filter({ visible: true })).toHaveCount(0);
  await expect(page.getByText(/最终完成/)).toHaveCount(0);
  expect(fixture.calls.some((c) => c.stop)).toBeTruthy();
  await page.getByRole('button', { name: '重新生成', exact: true }).last().click();
  await expect(page.getByText('重新生成完成', { exact: true })).toBeVisible();
  expect(fixture.calls.some((c) => c.regenerate_assistant_message_id)).toBeTruthy();
  await page.getByTestId('composer-input').filter({ visible: true }).fill('问我补贴用途');
  await page.getByTestId('composer-input').filter({ visible: true }).press('Enter');
  await page.getByRole('radio', { name: '办公桌椅' }).click();
  await expect(page.getByTestId('composer-stop').filter({ visible: true })).toHaveCount(0);
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await expect(page.getByTestId('composer-stop').filter({ visible: true })).toBeVisible();
  await expect.poll(() => fixture.calls.some((c) => c.messages?.[0]?.content.includes('办公桌椅'))).toBeTruthy();
  await expect(page.getByTestId('composer-stop').filter({ visible: true })).toHaveCount(0);
  const dataTransfer = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File(['test content'], 'notes.txt', { type: 'text/plain' }));
    return d;
  });
  await page.getByTestId('composer').filter({ visible: true }).dispatchEvent('drop', { dataTransfer });
  await expect(page.getByTestId('composer-file').filter({ visible: true })).toContainText('notes.txt');
  await expect(page.getByTestId('composer-send').filter({ visible: true })).toBeEnabled();
  await page.getByTestId('composer-send').filter({ visible: true }).click();
  await expect.poll(() => fixture.calls.some((c) => c.messages?.[0]?.content.includes('```attachments'))).toBeTruthy();
  expect(fixture.writes).toContain('/api/chat-files/upload');
  await expect(page.getByTestId('composer-stop').filter({ visible: true })).toHaveCount(0);
  await page
    .getByRole('button', { name: /notes.txt/ })
    .last()
    .click();
  await expect(
    page.getByTestId('client-inspector').filter({ visible: true }).getByText('test content', { exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  expect(warnings).toEqual([]);
});

test('P2 resizing preserves route, transcript, draft and a live reply in both directions', async ({ page }) => {
  const fixture = await installStation(page);
  await policy(page);
  const url = page.url();
  await page.getByTestId('composer-input').filter({ visible: true }).fill('未发送草稿');
  for (const width of [390, 1440, 390, 1024, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(page).toHaveURL(url);
    await expect(page.getByTestId('composer-input').filter({ visible: true })).toHaveValue('未发送草稿');
    await expect(page.getByText('$1,000', { exact: true })).toBeVisible();
  }
  await page.getByTestId('composer-input').filter({ visible: true }).fill('长回复');
  await page.getByTestId('composer-input').filter({ visible: true }).press('Enter');
  await expect(page.getByText('正在生成', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('composer-stop').filter({ visible: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId('composer-stop').filter({ visible: true }).click();
  await expect(page.getByTestId('composer-stop').filter({ visible: true })).toHaveCount(0);
  expect(fixture.calls.filter((c) => c.messages?.[0]?.content === '长回复')).toHaveLength(1);
});

test('P2 search and commands, notifications, account and row context menus', async ({ page }) => {
  const fixture = await installStation(page);
  await policy(page);
  const url = page.url();
  await page.keyboard.press('Meta+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.getByTestId('command-query').fill('补贴');
  await page.getByRole('option', { name: /远程办公政策/ }).waitFor();
  await page.getByTestId('command-query').press('Meta+Enter');
  await expect(page.getByTestId('client-inspector').filter({ visible: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(url);
  await page.getByTestId('rail-notifications').click();
  const notices = page.getByTestId('notifications-popover');
  await expect(notices.getByText('Sprouty 需要你确认补贴申请')).toBeVisible();
  await notices.getByRole('tab', { name: '团队动态' }).click();
  await expect(notices.getByText('远程办公政策', { exact: true })).toBeVisible();
  await notices.getByRole('tab', { name: '给我的', exact: true }).click();
  await notices.getByRole('button', { name: '全部标为已读' }).click();
  await expect(notices.getByRole('button', { name: '全部标为已读' })).toBeDisabled();
  await page.keyboard.press('Escape');
  const row = page.getByTestId('client-secondary').locator('[data-session=policy-chat]');
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '置顶', exact: true }).click();
  await expect.poll(() => fixture.sessions.find((s) => s.id === 'policy-chat')?.pinned).toBeTruthy();
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /在检视面板打开/ }).click();
  await expect(page.getByTestId('client-inspector').filter({ visible: true })).toBeVisible();
  await expect(
    page
      .getByTestId('client-inspector')
      .filter({ visible: true })
      .getByTestId('composer-input')
      .filter({ visible: true }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input').fill('政策问答');
  await dialog.getByRole('button', { name: /好|确定|保存/ }).click();
  await expect(row).toHaveText(/政策问答/);
  await page.getByTestId('rail-me').click();
  for (const name of ['账号', '文字大小', '我的 Agents', '退出登录'])
    await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+,');
  await expect(page.getByTestId('settings-overlay')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-overlay')).toHaveCount(0);
  await page.keyboard.press('Meta+n');
  await expect(page).toHaveURL(/\/$/);
});

test('P2 inspector open, back, three-level cap, promote, close and floating width', async ({ page }) => {
  await installStation(page);
  await policy(page);
  const url = page.url();
  await openPolicy(page);
  const panel = page.getByTestId('client-inspector').filter({ visible: true });
  await panel.getByRole('link', { name: '报销流程', exact: true }).click();
  await expect(panel.getByTestId('inspector-back')).toBeVisible();
  await panel.getByRole('link', { name: '设备清单', exact: true }).click();
  await panel.getByRole('link', { name: '远程办公政策', exact: true }).click();
  await panel.getByTestId('inspector-back').click();
  await expect(panel.getByRole('heading', { name: '报销流程', exact: true }).first()).toBeVisible();
  await panel.getByTestId('inspector-back').click();
  await expect(panel.getByRole('heading', { name: '远程办公政策', exact: true }).first()).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  const bounds = await panel.boundingBox();
  expect(bounds?.width).toBeGreaterThanOrEqual(360);
  expect(bounds?.x).toBeGreaterThan(800);
  await panel.getByRole('button', { name: '在主区打开', exact: true }).click();
  await expect(page.getByTestId('client-inspector').filter({ visible: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '远程办公政策', exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).last().click();
  await expect(page).toHaveURL(url);
  await openPolicy(page);
  await panel.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page).toHaveURL(url);
});

test('P2 rich blocks, sandboxed mermaid and HTML preview, branch and export', async ({ page }) => {
  const fixture = await installStation(page);
  await policy(page);
  await page.getByRole('button', { name: '分支为新对话', exact: true }).last().click();
  await expect(page).toHaveURL(/session=fork-/);
  expect(fixture.writes.some((p) => p.endsWith('/fork'))).toBeTruthy();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 Markdown', exact: true }).last().click();
  expect((await download).suggestedFilename()).toMatch(/\.md$/);
  await page.getByTestId('composer-input').filter({ visible: true }).fill('富块');
  await page.getByTestId('composer-input').filter({ visible: true }).press('Enter');
  for (const text of ['政策卡片', '核对政策', '补贴类型', '金额'])
    await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
  await expect(page.locator('iframe').first()).toHaveAttribute('sandbox', 'allow-scripts allow-downloads');
  await page.getByRole('button', { name: /补贴计算器/ }).click();
  await expect(page.frameLocator('iframe').last().getByText('预览可用')).toBeVisible();
  await expect(page.locator('iframe').last()).not.toHaveAttribute('sandbox', /allow-same-origin/);
});

test('P2 Agent DM uses its profile and shared conversations stay read-only', async ({ page }) => {
  const fixture = await installStation(page);
  await ready(page);
  await page.getByRole('button', { name: 'Ops Bot', exact: true }).click();
  await page.getByTestId('composer-input').filter({ visible: true }).fill('你好，Ops');
  await page.getByTestId('composer-input').filter({ visible: true }).press('Enter');
  await expect.poll(() => fixture.sessions.some((s) => s.profile_id === 'custom:ops')).toBeTruthy();
  await expect(page.getByTestId('composer-stop').filter({ visible: true })).toHaveCount(0);
  await page.goto('/chat?session=shared-chat');
  await expect(page.getByTestId('startup-splash')).toHaveCount(0);
  await expect(page.getByText(/林杰.*只读|只读/).first()).toBeVisible();
  await expect(page.getByTestId('composer-input').filter({ visible: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重新生成', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '对话选项', exact: true })).toHaveCount(0);
});

for (const width of [1440, 1280, 1024, 390])
  test(`P2 design screenshots and shortcuts at ${width}`, async ({ page }) => {
    await installStation(page);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await ready(page);
    await shot(page, '02', width);
    await shot(page, '16', width);
    const homeRow =
      width < 760
        ? page.getByTestId('client-main').getByRole('button', { name: /居家补贴和核心工时/ })
        : page.getByTestId('client-main').locator('[data-session=policy-chat]');
    await homeRow.first().click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    await shot(page, '09-context', width);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await page.getByTestId('command-query').fill('补贴');
    await expect(page.getByRole('option', { name: /远程办公政策/ })).toBeVisible();
    await shot(page, '08', width);
    await page.keyboard.press('Escape');
    if (width >= 760) {
      await page.getByTestId('rail-notifications').click();
      await expect(page.getByTestId('notifications-popover')).toBeVisible();
    } else await page.getByRole('button', { name: /通知/ }).click();
    await expect(page.getByText('Sprouty 需要你确认补贴申请')).toBeVisible();
    await shot(page, '09', width);
    await page.keyboard.press('Escape');
    await policy(page);
    await shot(page, '15', width);
    if (width === 1024) {
      await expect(page.getByTestId('client-secondary')).toBeHidden();
      await page.keyboard.press('Meta+\\');
      await expect(page.getByTestId('client-secondary')).toBeVisible();
      await page.keyboard.press('Meta+\\');
    }
    await openPolicy(page);
    await shot(page, '01', width);
    await shot(page, '14', width);
    await page.evaluate(() => localStorage.setItem('greenhouse_pref_theme', 'dark'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByTestId('startup-splash')).toHaveCount(0);
    await expect(page.getByTestId('client-inspector').filter({ visible: true })).toBeVisible();
    await shot(page, '12', width);
  });
