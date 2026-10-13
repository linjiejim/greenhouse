import { expect, test, type Locator, type Page } from '@playwright/test';
import { resolve } from 'node:path';

const MODULES = [
  'chat',
  'knowledge',
  'tables',
  'apps',
  'skills',
  'agents',
  'runs',
  'notifications',
  'settings',
  'admin',
  'login',
  'components',
];
/** Opens a Haven Select and picks an option; the list renders in a floating panel. */
async function choose(page: Page, scope: Page | Locator, label: string, option: string) {
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
/** Picks an item in the module column, opening the drawer first on phones. */
async function openSidebarItem(page: Page, isMobile: boolean, name: string) {
  if (isMobile) await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page
    .locator('.sidebar-item')
    .filter({ hasText: new RegExp(`^${name}`) })
    .click();
}

test('mobile drawer mirrors the native app: conversations first, modules at the bottom', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Mobile-specific navigation');
  await page.goto('/#chat');
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  const drawer = page.getByRole('complementary', { name: '模块目录' });
  // Agents sit at the top without a heading; the main Agent row is the larger one.
  await expect(drawer.locator('.sidebar-item.main')).toHaveText('Greeny');
  await expect(drawer.locator('.sidebar-section-title').getByText('Agents', { exact: true })).toHaveCount(0);
  await drawer.getByRole('navigation', { name: '模块' }).getByRole('button', { name: '表格', exact: true }).click();
  await expect(page.getByRole('heading', { name: '产品计划 / 任务', exact: true })).toBeVisible();
});

test('every module renders in both themes without backend requests or horizontal overflow', async ({ page }) => {
  const errors: string[] = [];
  const backendRequests: string[] = [];
  const sockets: string[] = [];
  if (process.env.DESIGN_PREVIEW_URL) page.on('websocket', (socket) => sockets.push(socket.url()));
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (/\/api(?:\/|$)/.test(new URL(request.url()).pathname)) backendRequests.push(request.url());
  });
  const window = page.getByTestId('product-window');
  for (const id of MODULES) {
    await page.goto(`/#${id}`);
    if (await page.getByRole('button', { name: '切换浅色', exact: true }).isVisible())
      await page.getByRole('button', { name: '切换浅色', exact: true }).click();
    await expect(window).toHaveAttribute('data-theme', 'light');
    const overflow = await window.evaluate((node) => node.scrollWidth - node.clientWidth);
    expect(overflow, id).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: '切换深色', exact: true }).click();
    await expect(window).toHaveAttribute('data-theme', 'dark');
    // Tokens come from the shared Native Haven source, not from prototype-local values.
    expect(await window.evaluate((node) => getComputedStyle(node).getPropertyValue('--gh-canvas').trim())).toBe(
      '#111113',
    );
  }
  expect(errors).toEqual([]);
  expect(backendRequests).toEqual([]);
  expect(sockets).toEqual([]);
});

test('the "?" keeps explanations off the page until asked for', async ({ page, isMobile }) => {
  await page.goto('/#admin');
  await openSidebarItem(page, isMobile, '服务');
  const explanation = page.getByText('每种能力都可以换成任意服务商', { exact: false });
  await expect(explanation).toHaveCount(0);
  await page.getByRole('button', { name: '说明：服务', exact: true }).click();
  await expect(explanation).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(explanation).toHaveCount(0);
});

test('a provider instance takes a write-only key and joins the fallback order', async ({ page, isMobile }) => {
  await page.goto('/#admin');
  await openSidebarItem(page, isMobile, '服务');
  await page
    .locator('.list-row')
    .filter({ hasText: '大模型' })
    .getByRole('button', { name: '配置', exact: true })
    .click();
  const drawer = page.getByRole('dialog', { name: '大模型' });
  await drawer.getByRole('button', { name: '添加实例', exact: true }).click();
  await choose(page, drawer, '厂商', 'Kimi');
  await drawer.getByRole('button', { name: '添加', exact: true }).click();
  await expect(drawer.getByText('请输入名称', { exact: true })).toBeVisible();
  await drawer.getByLabel('名称', { exact: false }).fill('公司 Kimi');
  await drawer.getByPlaceholder('粘贴新的 Key').fill('sk-test');
  await drawer.getByRole('button', { name: '保存', exact: true }).click();
  await expect(drawer.getByText(/^已配置/)).toBeVisible();
  await expect(drawer.getByPlaceholder('粘贴新的 Key')).toHaveCount(0);
  await drawer.getByRole('button', { name: '添加', exact: true }).click();
  await expect(drawer.locator('.order-index').filter({ hasText: '3' })).toBeVisible();
  await expect(drawer.getByText('公司 Kimi', { exact: true })).toBeVisible();
});

test('record drawer: view, then edit in place with validation, dirty-draft guard and save', async ({ page }) => {
  await page.goto('/#tables');
  const row = page.getByRole('button', { name: '完善成员邀请流程', exact: true });
  await row.click();
  const dialog = page.getByRole('dialog', { name: '完善成员邀请流程' });
  await expect(dialog.getByText('林杰', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(dialog.getByLabel('标题', { exact: false })).toBeFocused();
  await dialog.getByLabel('标题', { exact: false }).fill('');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.getByText('请输入标题', { exact: true })).toBeVisible();
  await dialog.getByLabel('标题', { exact: false }).fill('邀请流程已打磨');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: '放弃修改？' })).toBeVisible();
  await page.getByRole('button', { name: '继续编辑' }).click();
  await expect(page.getByLabel('标题', { exact: false })).toHaveValue('邀请流程已打磨');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const saved = page.getByRole('dialog', { name: '邀请流程已打磨' });
  await expect(saved.getByRole('button', { name: '编辑', exact: true })).toBeVisible();
  await saved.getByRole('button', { name: '关闭详情', exact: true }).click();
  await expect(saved).toHaveCount(0);
  await expect(page.getByRole('button', { name: '邀请流程已打磨', exact: true })).toBeFocused();
});

test('table filters, pagination, selection and bulk status share the same data', async ({ page }) => {
  await page.goto('/#tables');
  await page.getByLabel('搜索记录', { exact: true }).fill('不存在');
  await expect(page.getByText('没有匹配的记录', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认移动端导航', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 完善成员邀请流程', exact: true }).check();
  await page.getByRole('button', { name: '标为已完成', exact: true }).click();
  await choose(page, page, '筛选状态', '已完成');
  await expect(page.getByRole('button', { name: '完善成员邀请流程', exact: true })).toBeVisible();
  await expect(page.getByText('共 4 条', { exact: true })).toBeVisible();
});

test('the project template replaces the Projects module: table, board and timeline over one dataset', async ({
  page,
}) => {
  await page.goto('/#tables');
  await page.getByRole('tab', { name: '时间线', exact: true }).click();
  await expect(page.locator('.timeline-row')).toHaveCount(8);
  await page.getByRole('tab', { name: '看板', exact: true }).click();
  await expect(page.locator('.kanban-column')).toHaveCount(3);
});

test('stopping generation cancels pending writes and scenario reset clears live state', async ({ page }) => {
  await page.goto('/#chat');
  await page.clock.install();
  await page.getByLabel('对话状态', { exact: true }).selectOption('生成与停止');
  await page.getByRole('button', { name: '播放生成过程', exact: true }).click();
  await page.clock.runFor(700);
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  const stoppedText = await page.locator('.message.assistant .message-text').textContent();
  await page.clock.runFor(8000);
  expect(await page.locator('.message.assistant .message-text').textContent()).toBe(stoppedText);
  await expect(page.getByText('已停止', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重新生成', exact: true }).click();
  await page.getByLabel('对话状态', { exact: true }).selectOption('新会话');
  await page.clock.runFor(8000);
  await expect(page.locator('.message')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
});

test('voice input fills the composer and never sends by itself', async ({ page }) => {
  await page.goto('/#chat');
  await page.clock.install();
  const before = await page.locator('.message').count();
  await page.getByRole('button', { name: '语音输入', exact: true }).click();
  await expect(page.getByText('正在听', { exact: false })).toBeVisible();
  await page.clock.runFor(3500);
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(/帮我把本周进度整理成周报/);
  expect(await page.locator('.message').count()).toBe(before);
});

test('approval applies once; rejected and expired cards stay inactive', async ({ page }) => {
  await page.goto('/#chat');
  await page.getByLabel('对话状态', { exact: true }).selectOption('需要你：批准');
  await page.getByRole('button', { name: '批准', exact: true }).click();
  await expect(page.getByText('已批准', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '批准', exact: true })).toHaveCount(0);
  await page.getByLabel('预览页面', { exact: true }).selectOption('表格');
  await page.getByRole('button', { name: '完善成员邀请流程', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('已完成', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page.getByRole('button', { name: '组件', exact: true }).click();
  await page.clock.install();
  const expiry = page.locator('.sample').filter({ has: page.getByText('10 秒后过期', { exact: true }) });
  await expiry.getByRole('button', { name: '重新计时', exact: true }).click();
  await page.clock.runFor(11000);
  await expect(expiry.getByText('已过期', { exact: true })).toBeVisible();
  await expect(expiry.getByRole('button', { name: '批准', exact: true })).toHaveCount(0);
});

test('mentions, skills, attachments, read-only and retry are usable', async ({ page }) => {
  await page.goto('/#chat');
  await page.getByLabel('对话状态', { exact: true }).selectOption('新会话');
  const box = page.getByRole('textbox', { name: '消息', exact: true });
  await box.fill('@');
  await page.getByRole('option', { name: '卷卷 Agent', exact: true }).click();
  await expect(box).toHaveValue('@卷卷 ');
  await box.fill('/');
  await page.getByRole('option', { name: '整理周报 模板', exact: true }).click();
  await expect(box).toHaveValue('/整理周报 ');
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# 示例资料') });
  await expect(page.getByRole('button', { name: /移除 notes.md/ })).toBeVisible();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.message.user').getByText('notes.md')).toBeVisible();
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await page.getByLabel('对话状态', { exact: true }).selectOption('只读对话');
  await expect(page.getByText('这个 Agent 已归档，对话只能查看。', { exact: false })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveCount(0);
  await page.getByLabel('对话状态', { exact: true }).selectOption('工具与重试');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.locator('.chat-card-header').filter({ hasText: '8 条记录' })).toHaveCount(2);
});

test('artifact exports an actual Markdown file and the sandboxed preview is interactive', async ({ page }) => {
  await page.goto('/#chat');
  await page.getByLabel('对话状态', { exact: true }).selectOption('文件与产物');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载周报', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('产品改版周报.md');
  await page.getByRole('button', { name: '网页预览', exact: true }).click();
  await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  await page.frameLocator('iframe').getByRole('button', { name: '展开下周计划', exact: true }).click();
  await expect(
    page.frameLocator('iframe').getByRole('button', { name: '检查数据导入 · 确认移动端导航', exact: true }),
  ).toBeVisible();
});

test('modal traps focus and reduced motion still allows closing', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#tables');
  await page.getByRole('button', { name: '完善成员邀请流程', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '编辑', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: '关闭详情', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('captures principal desktop and mobile states', async ({ page, isMobile }) => {
  await page.goto('/#tables');
  if (isMobile) await page.getByRole('button', { name: '切换深色', exact: true }).click();
  await page.getByRole('button', { name: '完善成员邀请流程', exact: true }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.getByLabel('标题', { exact: false })).toBeVisible();
  await page.screenshot({
    animations: 'disabled',
    path: resolve(
      import.meta.dirname,
      '../../../design/greenhouse-v2',
      `interactive-${isMobile ? 'mobile-dark' : 'desktop-light'}.png`,
    ),
  });
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page.getByRole('button', { name: '组件', exact: true }).click();
  await page.screenshot({
    animations: 'disabled',
    path: resolve(
      import.meta.dirname,
      '../../../design/greenhouse-v2',
      `interactive-components-${isMobile ? 'mobile' : 'desktop'}.png`,
    ),
  });
});

test('mobile sheet can be dragged closed without scrolling its host', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Mobile sheet only');
  await page.goto('/#tables');
  const hostTop = await page.getByTestId('product-window').evaluate((node) => node.getBoundingClientRect().top);
  await page.getByRole('button', { name: '完善成员邀请流程', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveCSS('transform', 'none');
  expect(await page.getByTestId('product-window').evaluate((node) => node.getBoundingClientRect().top)).toBe(hostTop);
  const handle = await dialog.getByRole('button', { name: '下拉关闭详情', exact: true }).boundingBox();
  if (!handle) throw new Error('Missing sheet handle');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 125, { steps: 10 });
  await page.mouse.up();
  await expect(dialog).toHaveCount(0);
});

test('component lab opens at the top and its embedded chat never scrolls the page', async ({ page }) => {
  await page.goto('/#components');
  const lab = page.locator('.component-lab .scroll-page');
  await expect.poll(() => lab.evaluate((node) => node.scrollTop)).toBe(0);
  await expect(page.getByRole('heading', { name: '组件与状态', exact: true })).toBeInViewport();
  await page.getByRole('navigation', { name: '组件分区' }).getByRole('link', { name: '对话', exact: true }).click();
  await expect(page.getByRole('heading', { name: '对话与结果', exact: true })).toBeInViewport();
  await page.getByLabel('对话状态', { exact: true }).selectOption('生成与停止');
  const before = await lab.evaluate((node) => node.scrollTop);
  await page.getByRole('button', { name: '播放生成过程', exact: true }).click();
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  // Clicking a lower control may scroll it into view, but streaming itself must stay in the chat scroller.
  const afterClick = await lab.evaluate((node) => node.scrollTop);
  expect(afterClick).toBeGreaterThanOrEqual(before);
  await page.clock.install();
  await page.clock.runFor(7000);
  expect(await lab.evaluate((node) => node.scrollTop)).toBe(afterClick);
});

test('sidebar rows and rail buttons have right-click menus; the keyboard opens them too', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'Right-click is a desktop pattern; phones use a long press');
  await page.goto('/#chat');
  const row = page.locator('.sidebar-item').filter({ hasText: /^客户反馈总结$/ });
  await row.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '客户反馈总结的操作' });
  await expect(menu.getByRole('menuitem')).toHaveText(['置顶', '重命名', '复制链接', '导出 Markdown', '删除']);
  await menu.getByRole('menuitem', { name: '置顶', exact: true }).click();
  await expect(menu).toHaveCount(0);
  // Pinned chats move to the top of the 会话 section.
  await expect(page.locator('.sidebar-section').last().locator('.sidebar-item').nth(1)).toHaveText('客户反馈总结');
  await row.focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu.getByRole('menuitem', { name: '取消置顶', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(row).toBeFocused();
  await row.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: '删除', exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(row).toHaveCount(1);
  await page.getByRole('button', { name: '对话', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '新会话', exact: true }).click();
  await expect(page.getByRole('heading', { name: '新会话', exact: true })).toBeVisible();
});

test('Select and DatePicker are keyboard-first and Escape closes only the list', async ({ page }) => {
  await page.goto('/#tables');
  await page.getByRole('button', { name: '完善成员邀请流程', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '完善成员邀请流程' });
  await dialog.getByRole('button', { name: '编辑', exact: true }).click();
  const status = dialog.getByRole('combobox', { name: '记录状态', exact: true });
  await status.focus();
  await page.keyboard.press('ArrowDown');
  await expect(status).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(status).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(status).toHaveText('已完成');
  const due = dialog.getByRole('button', { name: /^截止日期/ });
  await due.click();
  const calendar = page.getByRole('dialog', { name: '截止日期', exact: true });
  // The start date (10 月 12 日) is the earliest allowed due date.
  await expect(calendar.getByRole('button', { name: '10 月 11 日 星期日', exact: true })).toBeDisabled();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(due).toHaveAccessibleName('截止日期：10 月 17 日 周六');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.getByText('已完成', { exact: true })).toBeVisible();
});

test('reply cards keep the status badge at the far right of the title row', async ({ page }) => {
  await page.goto('/#chat');
  await page.getByLabel('对话状态', { exact: true }).selectOption('需要你：其他类型');
  const headers = page.locator('.chat-card-header');
  await expect(headers).toHaveCount(4);
  for (const header of await headers.all()) {
    const box = (await header.boundingBox())!;
    const badge = (await header.locator('.badge').boundingBox())!;
    expect(box.x + box.width - (badge.x + badge.width)).toBeLessThanOrEqual(13);
    await expect(header.locator('.badge')).toHaveText('需要你');
  }
});

test('the detail drawer takes about 40% of the window; sign-in is one large button', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Phones use a bottom sheet');
  await page.goto('/#tables');
  await page.getByRole('button', { name: '完善成员邀请流程', exact: true }).click();
  const window = (await page.getByTestId('product-window').boundingBox())!;
  const panel = (await page.locator('.overlay-panel').boundingBox())!;
  const share = panel.width / window.width;
  expect(panel.width >= 480 || share >= 0.38).toBeTruthy();
  expect(share).toBeLessThanOrEqual(0.42);
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page.goto('/#login');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Greenhouse');
  const login = page.getByRole('button', { name: '登录', exact: true });
  expect((await login.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByLabel('密码', { exact: true }).fill('wrong');
  await login.click();
  await expect(page.getByText('邮箱或密码不正确', { exact: true })).toBeVisible();
});
