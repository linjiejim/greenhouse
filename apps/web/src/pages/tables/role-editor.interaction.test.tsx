/** @vitest-environment happy-dom */

/**
 * The custom-role rule editor under real interaction, and the capabilities a
 * custom role gets in the view container: table access none / read / edit, the
 * "show all fields" switch, per-field access, the dependency note ("hidden
 * because it depends on a hidden field" — the server's own closure), the
 * related-rows editor, unfinished conditions blocking save, and a grid that
 * offers no edit the role's compiled access would refuse.
 */

import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_TABLE_ACCESS_RULES,
  type TableAccessRules,
  type TableAccessSchemaFacts,
  type TableBaseAccessView,
} from '@greenhouse/types/table-access';
import { I18nProvider } from '../../lib/i18n';
import type { TableDefinition, TableField, TableRecord } from '../../lib/api/tables';
import { incompleteRowScope, RoleEditor } from './role-editor';
import { tableCapabilities } from './capabilities';
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

function field(id: number, tableId: number, name: string, type: TableField['type'], config: object = {}): TableField {
  return {
    id,
    table_id: tableId,
    name,
    type,
    required: false,
    is_primary: id === 1 || id === 10,
    config: JSON.stringify(config),
    position: id,
    created_by: 'u1',
    created_at: stamp,
    updated_at: stamp,
    archived_at: null,
  };
}

// Customers (1): Name, Amount, Rep, Commission = Amount × 0.1. Orders (2): No., Customer → Customers.
const customers = [
  field(1, 1, 'Name', 'text'),
  field(2, 1, 'Amount', 'number'),
  field(3, 1, 'Rep', 'user'),
  field(4, 1, 'Commission', 'formula'),
];
const orders = [field(10, 2, 'No.', 'text'), field(11, 2, 'Customer', 'relation', { relation: { targetTableId: 1 } })];
const fieldsByTable = new Map([
  [1, customers],
  [2, orders],
]);
const facts: TableAccessSchemaFacts = {
  tables: [
    { id: 1, name: 'Customers' },
    { id: 2, name: 'Orders' },
  ],
  fields: [...customers, ...orders].map((entry) => ({
    id: entry.id,
    tableId: entry.table_id,
    type: entry.type,
    name: entry.name,
    relationTargetTableId: entry.type === 'relation' ? 1 : null,
  })),
  dependencies: [{ fieldId: 4, dependsOnFieldId: 2 }],
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let latest: TableAccessRules;

function Harness() {
  const [rules, setRules] = useState<TableAccessRules>({ ...EMPTY_TABLE_ACCESS_RULES, tables: [] });
  latest = rules;
  return (
    <RoleEditor
      rules={rules}
      onChange={setRules}
      facts={facts}
      fieldsByTable={fieldsByTable}
      users={[{ id: 'u1', nickname: 'Jim', email: 'jim@example.com' }]}
    />
  );
}

async function mount(element: React.ReactElement) {
  await act(async () => {
    root.render(<I18nProvider initialLocale="en">{element}</I18nProvider>);
  });
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function card(tableId: number): HTMLElement {
  return container.querySelector(`[data-testid="role-table-${tableId}"]`) as HTMLElement;
}

async function press(scope: HTMLElement, label: string) {
  const button = [...scope.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);
  if (!button) throw new Error(`No button "${label}"`);
  await act(async () => button.click());
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function accessSelect(name: string): HTMLSelectElement {
  return container.querySelector(`select[aria-label="Access to ${name}"]`) as HTMLSelectElement;
}

beforeEach(() => {
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

describe('RoleEditor', () => {
  it('opens a table closed, then shows fields, hides one and its dependants', async () => {
    await mount(<Harness />);
    expect(card(1).textContent).toContain('This table is invisible to the role.');

    await press(card(1), 'Can read');
    expect(latest.tables).toEqual([{ tableId: 1, access: 'read', fields: [], fieldDefault: 'hidden' }]);
    expect(accessSelect('Amount').value).toBe('hidden');
    // A read rule never offers edit.
    expect([...accessSelect('Amount').options].map((option) => option.value)).toEqual(['hidden', 'read']);

    const showAll = card(1).querySelector('button[role="switch"][aria-label="Show all fields"]') as HTMLButtonElement;
    await act(async () => showAll.click());
    expect(latest.tables[0]!.fieldDefault).toBe('visible');
    expect(accessSelect('Amount').value).toBe('read');
    expect(card(1).textContent).not.toContain('Hidden because it depends on a hidden field');

    await choose(accessSelect('Amount'), 'hidden');
    expect(latest.tables[0]!.fields).toEqual([{ fieldId: 2, access: 'hidden' }]);
    expect(card(1).textContent).toContain('Hidden because it depends on a hidden field');
  });

  it('edits row scopes and keeps a relation to an invisible table read-only', async () => {
    await mount(<Harness />);
    await press(card(2), 'Can edit');
    const showAll = card(2).querySelector('button[role="switch"][aria-label="Show all fields"]') as HTMLButtonElement;
    await act(async () => showAll.click());
    expect(card(2).textContent).toContain('Read only: its linked table is hidden from this role');
    await press(card(1), 'Can read');
    expect(card(2).textContent).not.toContain('Read only: its linked table is hidden from this role');

    const rowsRead = card(1).querySelector('div.grid > div') as HTMLElement;
    await press(rowsRead, 'Related to them');
    expect(latest.tables.find((rule) => rule.tableId === 1)?.rows).toEqual({
      type: 'related',
      creator: true,
      fieldIds: [],
    });
    const repBox = [...card(1).querySelectorAll('label')].find((label) =>
      label.textContent?.includes('“Rep” includes them'),
    )!;
    await act(async () => (repBox.querySelector('input') as HTMLInputElement).click());
    expect(latest.tables.find((rule) => rule.tableId === 1)?.rows).toEqual({
      type: 'related',
      creator: true,
      fieldIds: [3],
    });

    // The orders rule can change rows, create, delete.
    expect(card(2).textContent).toContain('Rows they may change');
    const deleteBox = [...card(2).querySelectorAll('label')].find(
      (label) => label.textContent === 'Can delete records',
    )!;
    await act(async () => (deleteBox.querySelector('input') as HTMLInputElement).click());
    expect(latest.tables.find((rule) => rule.tableId === 2)?.delete).toBe(true);

    // An unfinished condition blocks saving.
    await press(rowsRead, 'Matching conditions');
    expect(incompleteRowScope(latest, fieldsByTable)).toEqual({ tableId: 1, index: 1 });

    await press(card(1), 'No access');
    expect(latest.tables.map((rule) => rule.tableId)).toEqual([2]);
  });
});

describe('custom role in the view container', () => {
  const table: TableDefinition = {
    id: 1,
    base_id: 3,
    name: 'Customers',
    description: null,
    position: 0,
    schema_revision: 1,
    created_by: 'u1',
    created_at: stamp,
    updated_at: stamp,
    archived_at: null,
  };
  const access: TableBaseAccessView = {
    level: 'custom',
    customRole: { id: 5, name: 'Sales' },
    tables: [
      {
        tableId: 1,
        access: 'edit',
        readableFieldIds: [1, 3],
        editableFieldIds: [1],
        canCreate: false,
        canDelete: false,
      },
    ],
  };
  const record: TableRecord = {
    id: 8,
    table_id: 1,
    values: { '1': 'Acme', '3': 'u1' },
    computed_values: {},
    revision: 1,
    created_by: 'u1',
    updated_by: 'u1',
    created_at: stamp,
    updated_at: stamp,
    deleted_at: null,
  };

  it('derives exact capabilities from the compiled access', () => {
    const caps = tableCapabilities(access, table);
    expect(caps).toMatchObject({
      canEdit: true,
      canCreate: false,
      canDelete: false,
      canBuild: false,
      canSaveView: false,
    });
    expect(caps.canEditField(1)).toBe(true);
    expect(caps.canEditField(3)).toBe(false);
    expect(tableCapabilities(access, { id: 99 }).canEdit).toBe(false);
    expect(tableCapabilities({ level: 'editor' }, table).canEditField(3)).toBe(true);
  });

  it('offers no add, delete or edit on fields the role cannot write', async () => {
    api.getTableSchema.mockResolvedValue({
      table,
      fields: [customers[0]!, customers[2]!],
      views: [],
    });
    api.queryTableRecords.mockResolvedValue({ records: [record], total: 1, nextCursor: null });
    await mount(
      <TablesViewContainer
        table={table}
        tables={[table]}
        role="viewer"
        access={access}
        users={[{ id: 'u1', nickname: 'Jim', email: 'jim@example.com' }]}
      />,
    );
    expect(container.querySelector('button[aria-label="Add record"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Delete record"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Edit Name"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Edit Rep"]')).toBeNull();
  });
});
