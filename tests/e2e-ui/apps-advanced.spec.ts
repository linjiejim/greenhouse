import type { APIResponse } from '@playwright/test';
import type { AppDraftView, AppCardQueryResult } from '@greenhouse/types/apps';
import { test, expect } from './fixtures';

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), `${response.url()}: ${await response.text()}`).toBeTruthy();
  return response.json() as Promise<T>;
}

test('installs a named template and evaluates an external card in the browser', async ({ page, api, runId }) => {
  test.setTimeout(60_000);
  let draft: AppDraftView | undefined;
  try {
    await page.goto('/#/apps');
    await page.getByTestId('app-center-templates').click();
    for (const key of ['procurement', 'it-tickets', 'crm', 'recruiting']) {
      await expect(page.getByTestId(`template-${key}`)).toBeVisible();
    }
    await page.getByTestId('template-crm-install').click();
    await page.getByTestId('template-new-name').fill(`${runId} CRM`);
    await page.getByTestId('template-create').click();
    await expect(page).toHaveURL(/#\/apps\/\d+\/edit$/);
    const appId = Number(/#\/apps\/(\d+)/.exec(page.url())![1]);
    draft = await json<AppDraftView>(await api.get(`/api/apps/${appId}/draft`));
    expect(draft.app.name).toBe(`${runId} CRM`);
    expect(draft.app.publishedVersion).toBeNull();
    await page.getByTestId('app-add-card').click();
    await page.getByTestId('app-catalog-group-advanced').locator('summary').click();
    await page.getByTestId('app-catalog-external').click();
    await expect(page.getByTestId('app-save-state')).toHaveAttribute('data-state', 'saved');
    draft = await json<AppDraftView>(await api.get(`/api/apps/${appId}/draft`));
    const appPage = draft.spec.pages[0]!;
    const external = appPage.cards.find((card) => card.kind === 'external')!;
    const result = await json<AppCardQueryResult>(
      await api.post(`/api/apps/${appId}/cards/query`, {
        data: { pageId: appPage.id, cardId: external.id, draft: true },
      }),
    );
    expect(result.kind).toBe('kpi');
    await page.goto(`/#/apps/${appId}?draft=1`);
    await expect(page.getByTestId(`app-card-${external.id}`)).toContainText(
      String(result.kind === 'kpi' ? result.value : ''),
    );
  } finally {
    if (draft) {
      await api.post(`/api/apps/${draft.app.id}/archive`);
      await api.post(`/api/tables/bases/${draft.app.baseId}/archive`);
    }
  }
});

test('custom source stays inert during review and after approval', async ({ page, api, runId }) => {
  const installed = await json<{ app: { id: number }; baseId: number }>(
    await api.post('/api/apps/templates/crm/install', { data: { name: `${runId} custom` } }),
  );
  const appId = installed.app.id;
  const draft = await json<AppDraftView>(await api.get(`/api/apps/${appId}/draft`));
  const marker = `${runId}-executed`;
  const source = `<script>document.body.innerHTML='<h1>${marker}</h1>'</script>`;
  const first = draft.spec.pages[0]!;
  first.cards = [{ id: 'code', kind: 'custom', layout: { x: 0, y: 0, w: 12, h: 4 }, html: source, bindings: [] }];
  try {
    const saved = await json<AppDraftView>(
      await api.put(`/api/apps/${appId}/draft`, { data: { spec: draft.spec, draftRevision: draft.draftRevision } }),
    );
    expect(saved.errors).toEqual([]);
    await json(await api.post(`/api/apps/${appId}/publish`, { data: { draftRevision: saved.draftRevision } }));
    await page.goto('/#/apps');
    await page.getByRole('button', { name: 'Component reviews', exact: true }).click();
    await page
      .getByTestId('app-custom-reviews')
      .getByRole('button', { name: new RegExp(`${runId} custom`) })
      .click();
    await expect(page.getByTestId('app-review-source')).toHaveText(source);
    await expect(page.getByRole('heading', { name: marker })).toHaveCount(0);
    await page.getByTestId('app-review-approve').click();
    await expect(page.getByTestId('app-review-source')).toBeHidden();
    await page.goto(`/#/apps/${appId}`);
    await expect(page.getByTestId('app-custom-code')).toContainText('execution is unavailable');
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: marker })).toHaveCount(0);
  } finally {
    await api.post(`/api/apps/${appId}/archive`);
    await api.post(`/api/tables/bases/${draft.app.baseId}/archive`);
  }
});
