/** @vitest-environment happy-dom */

/**
 * The view container under real interaction: `?record=` opens the drawer,
 * a saved view's columns follow its `fieldIds`, an inline edit goes through
 * the shared FieldEditor into one record write, a kanban view loads one capped
 * page, records refetch on `tables:records_changed`, a conflicting edit
 * reloads instead of overwriting, and the fields panel writes the view.
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import {
  TablesRequestError,
  type TableDefinition,
  type TableField,
  type TableRecord,
  type TableSchema,
} from '../../lib/api/tables';
import type { ServerWsEvent } from '@greenhouse/types/ws';
import { wsClient } from '../../lib/ws';
import { TablesViewContainer } from './view-container';

const api = vi.hoisted(() => ({
  getTableSchema: vi.fn(),
  queryTableRecords: vi.fn(),
  getTableRecord: vi.fn(),
  updateTableRecordWithReplay: vi.fn(),
  updateTableView: vi.fn(),
  aggregateTableRecords: vi.fn(),
}));
vi.mock('../../lib/api/tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/tables')>()),
  ...api,
}));

/** Handlers the page registered with the WS client — the test plays the server. */
const wsHandlers = new Set<(event: ServerWsEvent) => void>();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stamp = '2026-10-11T00:00:00.000Z';
const table: TableDefinition = {
  id: 7,
  base_id: 3,
  name: 'Deals',
  description: null,
  position: 0,
  schema_revision: 1,
  created_by: 'u1',
  created_at: stamp,
  updated_at: stamp,
  archived_at: null,
};

function field(id: number, name: string, type: TableField['type']): TableField {
  return {
    id,
    table_id: 7,
    name,
    type,
    required: false,
    is_primary: id === 1,
    config: '{}',
    position: id,
    created_by: 'u1',
    created_at: stamp,
    updated_at: stamp,
    archived_at: null,
  };
}

function record(id: number, values: Record<string, unknown>): TableRecord {
  return {
    id,
    table_id: 7,
    values,
    computed_values: {},
    revision: 1,
    created_by: 'u1',
    updated_by: 'u1',
    created_at: stamp,
    updated_at: stamp,
    deleted_at: null,
  };
}

const schema: TableSchema = {
  table,
  fields: [field(1, 'Name', 'text'), field(2, 'Amount', 'number')],
  views: [
    {
      id: 9,
      table_id: 7,
      name: 'Amount first',
      type: 'grid',
      scope: 'shared',
      owner_id: null,
      config: JSON.stringify({ fieldIds: [2, 1] }),
      position: 0,
      revision: 1,
      created_by: 'u1',
      created_at: stamp,
      updated_at: stamp,
    },
  ],
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function flush() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(focusRecordId?: number) {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <TablesViewContainer
          table={table}
          tables={[table]}
          role="owner"
          users={[{ id: 'u1', nickname: 'Jim', email: 'jim@example.com' }]}
          focusRecordId={focusRecordId}
        />
      </I18nProvider>,
    );
  });
  await flush();
}

function headerNames(): string[] {
  return [...container.querySelectorAll('thead th span.truncate')].map((cell) => cell.textContent ?? '');
}

beforeEach(() => {
  api.getTableSchema.mockResolvedValue(schema);
  api.queryTableRecords.mockResolvedValue({
    records: [record(5, { '1': 'Acme', '2': 10 })],
    total: 1,
    nextCursor: null,
  });
  api.getTableRecord.mockResolvedValue(record(5, { '1': 'Acme', '2': 10 }));
  api.updateTableRecordWithReplay.mockImplementation(async (_tableId, base, values) =>
    record(base.id, { '1': 'Acme', ...values }),
  );
  api.aggregateTableRecords.mockResolvedValue([]);
  vi.spyOn(wsClient, 'onEvent').mockImplementation((handler) => {
    wsHandlers.add(handler);
    return () => wsHandlers.delete(handler);
  });
  api.updateTableView.mockImplementation(async (viewId, input) => ({ ...schema.views[0]!, id: viewId, ...input }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  wsHandlers.clear();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('TablesViewContainer', () => {
  it('opens the record named by the route', async () => {
    await mount(5);
    expect(api.getTableRecord).toHaveBeenCalledWith(7, 5);
    expect(document.body.textContent).toContain('Record #5');
  });

  it('orders columns by the selected view, not the schema', async () => {
    await mount();
    expect(headerNames()).toEqual(['Name', 'Amount']);
    const select = container.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      select.value = '9';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(headerNames()).toEqual(['Amount', 'Name']);
  });

  it('applies a saved view’s query.filters (an Agent plan writes them) to the record query', async () => {
    const open = { combinator: 'and' as const, clauses: [{ fieldId: 2, operator: 'gt' as const, value: 5 }] };
    api.getTableSchema.mockResolvedValue({
      ...schema,
      views: [{ ...schema.views[0]!, name: 'Open deals', config: JSON.stringify({ query: { filters: [open] } }) }],
    });
    await mount();
    const select = container.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      select.value = '9';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    // Folded into the where the filter dialog edits, so the toolbar counts it too.
    expect(api.queryTableRecords).toHaveBeenLastCalledWith(7, expect.objectContaining({ where: open }));
    expect(container.querySelector('button[aria-label="Filter records · 1"]')).not.toBeNull();
  });

  it('edits a cell through the shared field editor and writes one value', async () => {
    await mount();
    const pencil = container.querySelector('button[aria-label="Edit Amount"]') as HTMLButtonElement;
    await act(async () => pencil.click());
    const input = container.querySelector('input[aria-label="Amount"]') as HTMLInputElement;
    expect(input.type).toBe('number');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '12.5');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();
    // One revision-checked write that replays over a newer revision when safe.
    expect(api.updateTableRecordWithReplay).toHaveBeenCalledTimes(1);
    expect(api.updateTableRecordWithReplay).toHaveBeenCalledWith(7, expect.objectContaining({ id: 5, revision: 1 }), {
      '2': 12.5,
    });
  });

  it('loads a kanban view as one capped page and refetches when records change elsewhere', async () => {
    const stage = field(3, 'Stage', 'single_select');
    stage.config = JSON.stringify({ options: [{ id: 'lead', label: 'Lead' }] });
    api.getTableSchema.mockResolvedValue({
      ...schema,
      fields: [...schema.fields, stage],
      views: [
        {
          ...schema.views[0]!,
          id: 10,
          name: 'Board',
          type: 'kanban',
          config: JSON.stringify({ kanban: { groupFieldId: 3 } }),
        },
      ],
    });
    await mount();
    expect(container.querySelector('select[aria-label="Rows per page"]')).not.toBeNull();
    const select = container.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      select.value = '10';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(container.querySelector('[data-testid="kanban-board"]')).not.toBeNull();
    expect(api.queryTableRecords).toHaveBeenLastCalledWith(7, expect.objectContaining({ limit: 500 }));
    // One capped page: no pager.
    expect(container.querySelector('select[aria-label="Rows per page"]')).toBeNull();

    const calls = api.queryTableRecords.mock.calls.length;
    const changed: ServerWsEvent = { type: 'tables:records_changed', baseId: 3, tableId: 7, recordIds: [5] };
    const otherTable: ServerWsEvent = { type: 'tables:records_changed', baseId: 3, tableId: 99, recordIds: [1] };
    await act(async () => {
      for (const handler of wsHandlers) {
        handler(otherTable);
        handler(changed);
      }
    });
    // Coalesced (1 s): one refetch for the matching event, none for the other table.
    await vi.waitFor(
      async () => {
        await flush();
        expect(api.queryTableRecords.mock.calls.length).toBe(calls + 1);
      },
      { timeout: 3000, interval: 100 },
    );
  });

  it('reloads and reports a conflicting edit instead of overwriting it', async () => {
    api.updateTableRecordWithReplay.mockRejectedValue(
      new TablesRequestError('View revision conflict', 409, { currentRevision: 2 }),
    );
    await mount();
    const calls = api.queryTableRecords.mock.calls.length;
    await act(async () => (container.querySelector('button[aria-label="Edit Amount"]') as HTMLButtonElement).click());
    const input = container.querySelector('input[aria-label="Amount"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '99');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();
    expect(container.textContent).toContain('This record was changed by someone else');
    expect(api.queryTableRecords.mock.calls.length).toBeGreaterThan(calls);
  });

  it('writes the fields panel to the view in one update', async () => {
    await mount();
    const select = container.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      select.value = '9';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    await act(async () => (container.querySelector('button[aria-label="Fields"]') as HTMLButtonElement).click());
    await flush();
    const row = document.body.querySelector(
      '[data-testid="fields-panel-row-1"] input[type="checkbox"]',
    ) as HTMLInputElement;
    await act(async () => row.click());
    const createdBy = [...document.body.querySelectorAll('label')].find((label) =>
      label.textContent?.includes('Created by'),
    )!;
    await act(async () => (createdBy.querySelector('input') as HTMLInputElement).click());
    const apply = [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Apply')!;
    await act(async () => apply.click());
    await flush();
    expect(api.updateTableView).toHaveBeenCalledWith(9, {
      revision: 1,
      config: { fieldIds: [2], systemFields: ['created_by'] },
    });
  });
});
