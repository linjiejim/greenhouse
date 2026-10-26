import { test, expect } from '@playwright/test';

test('projects: creates a project and shows it in the cards view', async ({ page, request }) => {
  const name = `e2e-project-${Date.now().toString(36)}`;
  await page.goto('/#/projects');
  const token = await page.evaluate(() => localStorage.getItem('greenhouse_access_token'));
  expect(token).toBeTruthy();
  const headers = { Authorization: `Bearer ${token}` };
  try {
    await page.getByTestId('projects-new').or(page.getByTestId('projects-new-empty')).first().click();
    await expect(page.getByTestId('project-create-dialog')).toBeVisible();
    await page.getByTestId('project-name-input').fill(name);
    await page.getByTestId('project-create-submit').click();
    await expect(page.getByTestId('project-create-dialog')).toBeHidden();
    await page.getByRole('button', { name: 'Cards', exact: true }).click();
    await expect(page.locator('main').getByText(name).first()).toBeVisible();
  } finally {
    const res = await request.get('/api/projects', { headers });
    const { projects } = (await res.json()) as { projects: Array<{ id: string; title: string }> };
    const mine = projects.find((project) => project.title === name);
    if (mine) expect((await request.delete(`/api/projects/${mine.id}`, { headers })).ok()).toBeTruthy();
  }
});
