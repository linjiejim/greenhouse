import { test, expect } from './fixtures';

/**
 * The extension seam end to end: the Playwright stack runs with
 * GREENHOUSE_EXTENSIONS=example (see playwright.config.ts), so the example
 * extension's routes, page, navigation and tool must all be live.
 */
test.describe('example extension', () => {
  test('is reported active and serves its own API and page', async ({ page, api, runId }) => {
    const list = await api.get('/api/extensions');
    expect(list.ok()).toBe(true);
    const { extensions } = (await list.json()) as { extensions: Array<{ id: string }> };
    expect(extensions.map((e) => e.id)).toContain('example');

    // The page lives at its own top-level hash and renders the extension UI.
    await page.goto('/#/example');
    await expect(page.getByTestId('example-notes-page')).toBeVisible();

    const body = `${runId} first note`;
    await page.getByTestId('example-note-input').fill(body);
    await page.getByTestId('example-note-submit').click();
    await expect(page.getByTestId('example-note-list')).toContainText(body);

    // The same note is visible through the extension's route, under the core auth guard.
    const res = await api.get('/api/ext/example/notes');
    expect(res.ok()).toBe(true);
    const { notes } = (await res.json()) as { notes: Array<{ id: number; body: string }> };
    const created = notes.find((n) => n.body === body);
    expect(created).toBeTruthy();

    // The "More" menu lists the extension page; the tool joined the catalog.
    await page.getByRole('button', { name: 'More', exact: true }).first().hover();
    await expect(page.getByRole('menuitem', { name: 'Example notes' })).toBeVisible();
    const tools = await api.get('/api/tools');
    const { tools: catalog } = (await tools.json()) as { tools: Array<{ id: string }> };
    expect(catalog.map((t) => t.id)).toContain('example_notes_query');

    // The Administration module renders through ModulePage under core's
    // `admin.<key>` id — the shape a private extension's admin panel uses.
    await page.goto('/#/administration/example');
    await expect(page.getByTestId('example-admin-module')).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);

    if (created) await api.delete(`/api/ext/example/notes/${created.id}`);
  });
});
