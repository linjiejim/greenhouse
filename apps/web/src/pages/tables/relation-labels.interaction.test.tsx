/**
 * @vitest-environment happy-dom
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableField, TableRecord } from '../../lib/api/tables';
import { RecordDetailContent } from './record-detail-drawer';
import { renderTableFieldValue } from './field-value';
import { relationIdsOf, resetRelationLabelCache, useRelationLabels } from './relation-labels';

const mocks = vi.hoisted(() => ({ getTableSchema: vi.fn(), getTableRecord: vi.fn() }));

vi.mock('../../lib/api/tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/tables')>()),
  getTableSchema: mocks.getTableSchema,
  getTableRecord: mocks.getTableRecord,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = '2026-10-26T00:00:00.000Z';
const field = (id: string, over: Partial<TableField>): TableField => ({
  id,
  table_id: '7',
  name: `Field ${id}`,
  type: 'text',
  required: false,
  is_primary: false,
  config: {},
  position: Number(id),
  created_by: 'user-1',
  created_at: at,
  updated_at: at,
  archived_at: null,
  ...over,
});
const record = (id: string, values: TableRecord['values'], tableId = '7'): TableRecord => ({
  id,
  table_id: tableId,
  values,
  computed_values: {},
  revision: 1,
  created_by: 'user-1',
  updated_by: 'user-1',
  created_at: at,
  updated_at: at,
  deleted_at: null,
});

const fields = [
  field('1', { name: 'Name', is_primary: true }),
  field('2', { name: 'Customer', type: 'relation', config: { relation: { targetTableId: '9', multiple: false } } }),
  field('3', { name: 'Tags', type: 'relation', config: { relation: { targetTableId: '9', multiple: true } } }),
];
const customers: Record<string, TableRecord> = {
  '501': record('501', { '90': 'Acme Ltd' }, '9'),
  '502': record('502', { '90': 'Globex' }, '9'),
};

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

async function flush() {
  for (let i = 0; i < 4; i += 1) await act(async () => Promise.resolve());
}

beforeEach(() => {
  resetRelationLabelCache();
  mocks.getTableSchema.mockReset().mockResolvedValue({
    table: { id: '9' },
    fields: [
      field('91', { table_id: '9', name: 'Code' }),
      field('90', { table_id: '9', name: 'Company', is_primary: true }),
    ],
    views: [],
  });
  mocks.getTableRecord.mockReset().mockImplementation(async (_table: string, id: string) => {
    if (!customers[id]) throw new Error('not found');
    return customers[id];
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('relation values show the linked record', () => {
  it('shows the primary field of the linked record in the record drawer, single and multiple', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <RecordDetailContent
          tableName="Orders"
          record={record('42', { '1': 'Order 42', '2': '501', '3': ['501', '502', '599'] })}
          fields={fields}
          users={[]}
          canEdit={false}
          onClose={vi.fn()}
          onEdit={vi.fn()}
        />,
      );
    });
    await flush();
    const text = container.textContent ?? '';
    expect(text).toContain('Acme Ltd');
    expect(text).toContain('Globex');
    expect(text).not.toMatch(/(^|[^#])501/);
    // A record that cannot be read stays an id.
    expect(text).toContain('#599');
    // The target schema is read once for all three ids.
    expect(mocks.getTableSchema).toHaveBeenCalledTimes(1);
  });

  it('labels grid cells through the same lookup, #id until known', async () => {
    const seen: string[] = [];
    function Cells() {
      const rows = [record('1', { '2': 502 }), record('2', { '2': null })];
      const lookup = useRelationLabels(fields, rows);
      seen.push(
        rows.map((row) => String(renderTableFieldValue(fields[1]!, row.values['2'], new Map(), lookup))).join('|'),
      );
      return null;
    }
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(<Cells />));
    await flush();
    expect(seen[0]).toContain('#502');
    expect(seen.at(-1)).toContain('Globex');
  });

  it('reads single, multiple and legacy numeric values', () => {
    expect(relationIdsOf('5')).toEqual(['5']);
    expect(relationIdsOf(5)).toEqual(['5']);
    expect(relationIdsOf(['#5', 6])).toEqual(['5', '6']);
    expect(relationIdsOf(null)).toEqual([]);
    expect(relationIdsOf('')).toEqual([]);
  });
});
