import { expect, test } from '@playwright/test';
import type { AppDraft, Base, Connector, MemberSummary } from '@greenhouse/contract';
import { apiAs } from './api';
import { as, open } from './fixtures';
import { E2E } from './env';

test('external cards show plain data using each viewer’s own connection', async ({ page, request, browser }) => {
  const connector = await apiAs<Connector>(request, 'lin', 'POST', '/api/admin/connectors', {
    name: 'External app desk',
    slug: 't12-external',
    url: `http://127.0.0.1:${E2E.llmPort}/mcp/key`,
    auth_mode: 'per_member',
    auth_header: 'X-Api-Key',
  });
  await apiAs(request, 'lin', 'POST', '/api/me/connections', { connector_id: connector.id, key: 'e2e-good-key' });
  const base = await apiAs<Base>(request, 'lin', 'POST', '/api/tables/bases', { name: 'External cards' });
  const members = await apiAs<{ items: MemberSummary[] }>(request, 'lin', 'GET', '/api/members');
  const mei = members.items.find((m) => m.name === 'Mei')!;
  await apiAs(request, 'lin', 'PUT', `/api/tables/bases/${base.id}/share`, {
    items: [{ type: 'member', id: mei.id, role: 'viewer' }],
  });
  const draft = await apiAs<AppDraft>(request, 'lin', 'POST', '/api/apps', { name: 'External app', base_id: base.id });
  const source = { connector: connector.slug, tool: 'lookup_order', arguments: { order_id: 't12-card-data' } };
  const saved = await apiAs<AppDraft>(request, 'lin', 'PUT', `/api/apps/${draft.app.id}/draft`, {
    revision: draft.revision,
    name: 'External app',
    description: '',
    spec: {
      roles: [],
      pages: [
        {
          id: 'home',
          name: 'Home',
          cards: [
            {
              id: 'number',
              kind: 'external',
              title: 'External count',
              source,
              map: { kind: 'number', value: '/total' },
            },
            {
              id: 'table',
              kind: 'external',
              title: 'External table',
              source,
              map: { kind: 'table', rows: '/rows', columns: [{ label: 'Name', path: '/name' }] },
            },
          ],
        },
      ],
    },
  });
  await apiAs(request, 'lin', 'POST', `/api/apps/${draft.app.id}/publish`, {
    revision: saved.revision,
    audience: [{ principal_type: 'member', principal_id: mei.id, role: 'use' }],
  });
  await open(page, `/#/apps/${draft.app.id}`);
  await expect(page.getByText('42', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '<b>Plain external text</b>', exact: true })).toBeVisible();
  expect(await page.locator('.app-ap-table b').count()).toBe(0);
  const context = await browser.newContext({ storageState: as('mei') });
  try {
    const other = await context.newPage();
    await open(other, `/#/apps/${draft.app.id}`);
    await expect(other.getByText('42', { exact: true })).toBeHidden();
    await apiAs(request, 'mei', 'POST', '/api/me/connections', { connector_id: connector.id, key: 'e2e-good-key' });
    await other.reload();
    await expect(other.getByText('42', { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});
