import '../__tests__/setup.js';
/**
 * @vitest-environment happy-dom
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableField, TableRecord } from '../api';
import { RecordDetailContent } from './record-detail-drawer';
import { renderTableFieldValue } from './field-value';
import {
  invalidateRelationLabels,
  relationIdsOf,
  resetRelationLabelCache,
  useRelationLabels,
  type RelationLabelLookup,
} from './relation-labels';

const mocks = vi.hoisted(() => ({ getTableSchema: vi.fn(), queryTableRecords: vi.fn() }));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getTableSchema: mocks.getTableSchema,
  queryTableRecords: mocks.queryTableRecords,
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
  mocks.queryTableRecords.mockReset().mockImplementation(async (_table: string, query: { recordIds: string[] }) => {
    const records = query.recordIds.map((id) => customers[id]).filter(Boolean);
    return { records, total: records.length, nextCursor: null };
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
    // The target schema is read once, and the linked records in one query for both fields.
    expect(mocks.getTableSchema).toHaveBeenCalledTimes(1);
    expect(mocks.queryTableRecords).toHaveBeenCalledTimes(1);
    expect(mocks.queryTableRecords).toHaveBeenCalledWith('9', { recordIds: ['501', '502', '599'], limit: 3 });
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

  it('reads labels again after an invalidation, and retries a lookup that failed', async () => {
    mocks.queryTableRecords.mockRejectedValueOnce(new Error('offline'));
    let lookup: RelationLabelLookup = () => undefined;
    function Probe({ rows }: { rows: TableRecord[] }) {
      lookup = useRelationLabels(fields, rows);
      return null;
    }
    container = document.createElement('div');
    root = createRoot(container);
    const render = async (rows: TableRecord[]) => {
      await act(async () => root?.render(<Probe rows={rows} />));
      await flush();
    };
    await render([record('1', { '2': '501' })]);
    // The failure is not remembered: the next records ask again.
    expect(lookup(fields[1]!, '501')).toBeUndefined();
    await render([record('1', { '2': '501' })]);
    expect(lookup(fields[1]!, '501')).toBe('Acme Ltd');
    expect(mocks.queryTableRecords).toHaveBeenCalledTimes(2);

    // Cached until invalidated: a rename shows once the table is reloaded.
    await render([record('1', { '2': '501' })]);
    expect(mocks.queryTableRecords).toHaveBeenCalledTimes(2);
    customers['501'] = record('501', { '90': 'Acme Group' }, '9');
    try {
      invalidateRelationLabels('9');
      await render([record('1', { '2': '501' })]);
      expect(lookup(fields[1]!, '501')).toBe('Acme Group');
      // A linked record that is gone loses its label.
      delete customers['501'];
      invalidateRelationLabels();
      await render([record('1', { '2': '501' })]);
      expect(lookup(fields[1]!, '501')).toBeUndefined();
    } finally {
      customers['501'] = record('501', { '90': 'Acme Ltd' }, '9');
    }
  });

  it('looks up only the fields it is given', async () => {
    function Probe() {
      useRelationLabels([fields[0]!], [record('1', { '2': '501' })]);
      return null;
    }
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(<Probe />));
    await flush();
    expect(mocks.queryTableRecords).not.toHaveBeenCalled();
  });

  it('reads single, multiple and legacy numeric values', () => {
    expect(relationIdsOf('5')).toEqual(['5']);
    expect(relationIdsOf(5)).toEqual(['5']);
    expect(relationIdsOf(['#5', 6])).toEqual(['5', '6']);
    expect(relationIdsOf(null)).toEqual([]);
    expect(relationIdsOf('')).toEqual([]);
  });
});
