/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DataCatalog } from '@greenhouse/types/hub-context';
import { I18nProvider } from '../../lib/i18n';
import { DataCatalogPage } from './data-catalog';

const api = vi.hoisted(() => ({ fetchDataCatalog: vi.fn() }));
vi.mock('../../lib/api/hub-context', () => api);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

async function render() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(I18nProvider, { initialLocale: 'en', children: createElement(DataCatalogPage) }));
  });
  for (let i = 0; i < 30 && container.querySelector('.animate-spin'); i++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  return container;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

const catalog: DataCatalog = {
  generated_at: '2026-10-24T00:00:00.000Z',
  truncated: false,
  bases: [
    {
      kind: 'tables_base',
      id: '3',
      name: 'Sales pipeline',
      description: 'Deals by stage',
      visibility: 'team',
      role: 'viewer',
      owner: { id: 'u1', name: 'Ada' },
      last_changed_at: '2026-10-20T08:00:00.000Z',
      url: '#/tables/3',
      tables: [{ id: '9', name: 'Deals', row_count: 128, last_changed_at: '2026-10-20T08:00:00.000Z' }],
      table_count: 60,
      tables_truncated: true,
      reach: [
        { tool: 'tables_query', access: 'read', group: 'tables', how: 'tables_query action=tables.list base_id=3' },
      ],
    },
  ],
  extensions: [
    {
      kind: 'extension',
      id: 'crm',
      name: 'CRM',
      description: 'Customers and deals',
      record_kinds: ['ext:crm:company'],
      exports: [{ type: 'crm_customers', describe: 'every customer matching filters' }],
      reach: [
        { tool: 'crm_query', access: 'read', group: 'crm', how: 'Query customers.' },
        { tool: 'export_data', access: 'read', group: null, how: 'In Greenhouse chat only' },
      ],
    },
  ],
};

describe('Tables › Data catalog', () => {
  it('lists bases with row counts and owner, extension sources, and the tool that reaches each', async () => {
    api.fetchDataCatalog.mockResolvedValue(catalog);
    const page = await render();
    const base = page.querySelector('[data-testid="data-catalog-base"]')!;
    expect(base.textContent).toContain('Sales pipeline');
    expect(base.textContent).toContain('128 rows');
    expect(base.textContent).toContain('Owner: Ada');
    expect(base.textContent).toContain('tables_query');
    expect(base.textContent).toContain('scope mcp:tables');
    expect(base.querySelector('a[href="#/tables/3/table/9"]')?.textContent).toBe('Deals');
    expect(base.querySelector('[data-testid="data-catalog-tables-truncated"]')?.textContent).toBe(
      'Showing 1 of 60 tables — open the base for the rest.',
    );

    const source = page.querySelector('[data-testid="data-catalog-extension"]')!;
    expect(source.textContent).toContain('CRM');
    expect(source.textContent).toContain('Searchable records: ext:crm:company');
    expect(source.textContent).toContain('crm_query');
    expect(source.textContent).toContain('in Greenhouse chat only');
  });

  it('says so when there is nothing to read', async () => {
    api.fetchDataCatalog.mockResolvedValue({ ...catalog, bases: [], extensions: [] });
    const page = await render();
    expect(page.textContent).toContain('No data sources you can read yet');
  });
});
