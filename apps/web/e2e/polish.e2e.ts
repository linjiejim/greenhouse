import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { Base, Skill } from '@greenhouse/contract';
import { apiAs } from './api';
import { composer, open } from './fixtures';

async function captureChoice(page: Page, name: string) {
  const pictures = new URL('../../../artifacts/t10/choices/', import.meta.url).pathname;
  mkdirSync(pictures, { recursive: true });
  for (const [theme, width] of [
    ['light', 1440],
    ['dark', 1440],
    ['light', 390],
    ['dark', 390],
  ] as const) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${pictures}${name}-${theme}-${width}.png`, fullPage: true, animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test('module lists have a single create action, including an empty list', async ({ page }) => {
  for (const [path, name] of [
    ['tables', '新建表格'],
    ['apps', '新建应用'],
    ['agents', '新建 Agent'],
  ] as const) {
    await open(page, `/#/${path}`);
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
  }
});

test('Markdown keeps single tildes and sanitizes reply HTML in the browser', async ({ page }) => {
  await open(page, '/#/c/new');
  await composer(page).fill(
    '19~24°C ~原文~ ~~删除~~ <img src=x onerror="window.polishInjected=true"> <script>window.polishInjected=true</script>',
  );
  await composer(page).press('Enter');
  const reply = page.locator('.app-message.is-reply').last();
  await expect(reply).toContainText('19~24°C ~原文~');
  await expect(reply.locator('del')).toHaveText('删除');
  expect(await page.evaluate(() => 'polishInjected' in window)).toBe(false);
  await expect(reply.locator('script, [onerror]')).toHaveCount(0);
});

test('a form picker closes after pointer and keyboard picks and restores focus', async ({ page }) => {
  await open(page, '/#/admin/services');
  await page
    .getByRole('main')
    .getByRole('button', { name: /^大模型/ })
    .click();
  const drawer = page.getByRole('dialog', { name: '大模型', exact: true });
  const trigger = drawer.getByRole('combobox', { name: '默认', exact: true });
  await trigger.click();
  await page.getByRole('option', { selected: true }).click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();
  await trigger.press('ArrowDown');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await trigger.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
});

test('a form multi-picker stays open for consecutive pointer picks', async ({ page }) => {
  await open(page, '/');
  await page.getByRole('button', { name: '新房间', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新房间', exact: true });
  const trigger = dialog.getByRole('combobox', { name: '添加的人', exact: true });
  await trigger.click();
  await page.getByRole('option', { name: /Mei/ }).click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('option', { name: /Kai/ }).click();
  await expect(page.getByRole('option', { selected: true })).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
});

test('choice fields in skill calls and question cards close after a pick', async ({ page, request }) => {
  const skill = await apiAs<Skill>(request, 'lin', 'POST', '/api/skills', {
    kind: 'template',
    name: 'polish-choice',
    description: 'Choose a city',
    body: 'Plan for {{city}}.',
    variables: [{ key: 'city', label: 'City', type: 'choice', options: ['Kyoto', 'Osaka'] }],
  });
  await open(page, `/#/c/new?skill=${skill.id}`);
  await expect(page.locator('.app-chip.is-skill')).toHaveText('/polish-choice');
  const city = page.getByRole('combobox', { name: 'City', exact: true });
  await city.click();
  await page.getByRole('option', { name: 'Kyoto', exact: true }).click();
  await expect(city).toHaveAttribute('aria-expanded', 'false');
  await expect(city).toBeFocused();
  await captureChoice(page, 'skill');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.app-skill-tag')).toContainText('Kyoto');
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeHidden();

  await open(page, '/#/c/new');
  await composer(page).fill('ask me choices');
  await composer(page).press('Enter');
  const card = page.locator('.gh-chat-card', { hasText: 'Which city?' });
  await expect(card.getByRole('button', { name: 'Osaka', exact: true })).toBeVisible();
  await captureChoice(page, 'question');
  await card.getByRole('button', { name: 'Osaka', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Osaka', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(card.getByText('已完成')).toBeVisible();
  await expect(page.getByText('Done.', { exact: true })).toBeVisible();
});

test('a picker stays beside its trigger while the containing popover animates', async ({ page, request }) => {
  const base = await apiAs<Base>(request, 'lin', 'POST', '/api/tables/bases', {
    name: 'Picker placement',
    template: 'project',
  });
  const table = base.tables.find((item) => item.name === '任务')!;
  await open(page, `/#/tables/${base.id}/${table.id}`);
  await page.addStyleTag({ content: '.gh-popover { animation-duration: 20s !important; }' });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.getByRole('button', { name: '分组', exact: true }).click();
  const trigger = page.getByRole('combobox', { name: '分组字段', exact: true });
  await trigger.click();
  const option = page.getByRole('option', { name: '负责人', exact: true });
  await expect(option).toBeInViewport();
  const anchor = (await trigger.boundingBox())!;
  const panel = (await page.locator('.gh-picker-panel').boundingBox())!;
  expect(Math.abs(panel.x - anchor.x)).toBeLessThan(8);
  expect(Math.abs(panel.y - anchor.y - anchor.height)).toBeLessThan(12);
  await option.click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '按「负责人」分组' })).toBeVisible();
  expect(errors).toEqual([]);
});
