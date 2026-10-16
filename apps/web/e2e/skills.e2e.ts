import { expect, test } from '@playwright/test';
import { composer, open } from './fixtures';

test('skills: make a template, run it with / and its blank, and equip an Agent with it', async ({ page }, testInfo) => {
  // A failed reply can leave the created skill behind for a retry.
  const skillName = testInfo.retry ? `trip-plan-retry-${testInfo.retry}` : 'trip-plan';
  await open(page, '/#/skills');
  await page.getByRole('main').getByRole('button', { name: '新建技能' }).click();
  const drawer = page.getByRole('dialog', { name: '新建技能' });
  await drawer.getByLabel(/^调用名/).fill(skillName);
  await drawer.getByLabel(/^用途/).fill('Plan a weekend trip');
  await drawer.getByLabel(/^说明/).fill('Plan a weekend trip to {{city}}, with trains and food.');
  await drawer.getByRole('button', { name: '加一个空' }).click();
  await drawer.getByRole('textbox', { name: '占位名' }).fill('city');
  await drawer.getByRole('textbox', { name: '显示的名字' }).fill('City');
  await drawer.getByRole('button', { name: '创建技能' }).click();

  // Its page: what it is for, its blank, and a way to use it.
  const detail = page.getByRole('dialog', { name: skillName });
  await expect(detail.getByText('Plan a weekend trip', { exact: true })).toBeVisible();
  await expect(detail.getByText('{{city}}', { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '在对话里使用' }).click();
  await expect(page).toHaveURL(/#\/c\/new\?skill=/);
  await expect(page.locator('.app-chip.is-skill')).toContainText(`/${skillName}`);

  // A required blank is asked for before it runs.
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByRole('alert')).toContainText('City');
  await page.getByRole('textbox', { name: /^City/ }).fill('Kyoto');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page).toHaveURL(/#\/c\/cnv_/);
  await expect(page.locator('.app-skill-tag')).toContainText(`/${skillName}`);
  await expect(page.locator('.app-skill-tag')).toContainText('Kyoto');
  await expect(page.getByRole('article', { name: 'Greeny' }).last()).toContainText('Echo', { timeout: 20_000 });

  // `/` lists it in the composer.
  await composer(page).fill('/trip');
  await expect(page.getByRole('option', { name: new RegExp(`/${skillName}(?:\\s|$)`) })).toBeVisible();
  await page.keyboard.press('Escape');

  // Equip Greeny with it.
  await page.goto('/#/agents/main?tab=abilities');
  await page.getByRole('combobox', { name: '技能' }).click();
  await page.getByRole('option', { name: new RegExp(`/${skillName}(?:\\s|$)`) }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('combobox', { name: '技能' })).toContainText(`/${skillName}`);
});
