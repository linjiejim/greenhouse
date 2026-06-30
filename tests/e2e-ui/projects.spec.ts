import { test, expect } from './fixtures';

test.describe('projects', () => {
  test('creates a project and shows it in the list', async ({ page, api, runId }) => {
    const name = `${runId}-proj`;

    await page.goto('/#/projects');

    // Toolbar "new" button, or the empty-state one when there are no projects yet.
    const newBtn = page.getByTestId('projects-new').or(page.getByTestId('projects-new-empty'));
    await newBtn.first().click();

    const dialog = page.getByTestId('project-create-dialog');
    await expect(dialog).toBeVisible();

    await page.getByTestId('project-name-input').fill(name);
    await page.getByTestId('project-create-submit').click();

    await expect(dialog).toBeHidden();

    // Projects default to the Gantt view on desktop; switch to Cards to see the list.
    await page.getByRole('button', { name: 'Cards' }).click();
    await expect(page.getByText(name)).toBeVisible();

    // Cleanup — the UI only archives; hard-delete the row via the API.
    // (project name is stored under `title`)
    const res = await api.get('/api/projects');
    const { projects } = (await res.json()) as { projects: Array<{ id: number; title: string }> };
    const mine = projects.find((p) => p.title === name);
    if (mine) {
      const del = await api.delete(`/api/projects/${mine.id}`);
      expect(del.ok()).toBeTruthy();
    }
  });
});
