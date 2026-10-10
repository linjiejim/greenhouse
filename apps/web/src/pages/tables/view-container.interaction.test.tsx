/** @vitest-environment happy-dom */

/**
 * The view container under real interaction: `?record=` opens the drawer,
 * a saved view's columns follow its `fieldIds`, and an inline edit goes
 * through the shared FieldEditor into one record write.
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import type { TableDefinition, TableField, TableRecord, TableSchema } from '../../lib/api/tables';
import { TablesViewContainer } from './view-container';

const api = vi.hoisted(() => ({
  getTableSchema: vi.fn(),
  queryTableRecords: vi.fn(),
  getTableRecord: vi.fn(),
  updateTableRecord: vi.fn(),
}));
vi.mock('../../lib/api/tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/tables')>()),
  ...api,
}));

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
  api.updateTableRecord.mockImplementation(async (_tableId, recordId, _revision, values) =>
    record(recordId, { '1': 'Acme', ...values }),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.clearAllMocks();
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
    expect(api.updateTableRecord).toHaveBeenCalledTimes(1);
    expect(api.updateTableRecord).toHaveBeenCalledWith(7, 5, 1, { '2': 12.5 });
  });
});
