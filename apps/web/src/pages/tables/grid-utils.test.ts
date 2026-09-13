import { describe, expect, it } from 'vitest';
import type { TableField, TableRecord } from '../../lib/api/tables';
import { buildPasteBatch, parseClipboardMatrix, parsePastedCell } from './grid-utils';

const users = [{ id: 'user-1', nickname: 'Jim', email: 'jim@example.com' }];

function field(id: number, type: TableField['type'], config = '{}'): TableField {
  return {
    id,
    table_id: 1,
    name: `Field ${id}`,
    type,
    required: false,
    is_primary: false,
    config,
    position: id,
    created_by: 'user-1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    archived_at: null,
  };
}

describe('Tables Grid clipboard helpers', () => {
  it('parses tabular clipboard text without manufacturing a trailing row', () => {
    expect(parseClipboardMatrix('Alpha\t2\r\nBeta\t3\r\n')).toEqual([
      ['Alpha', '2'],
      ['Beta', '3'],
    ]);
  });

  it('normalizes typed select, user, number and boolean values', () => {
    expect(
      parsePastedCell(
        field(1, 'single_select', JSON.stringify({ options: [{ id: 'planned', label: 'Planned' }] })),
        'Planned',
        users,
      ),
    ).toBe('planned');
    expect(parsePastedCell(field(2, 'user'), 'jim@example.com', users)).toBe('user-1');
    expect(parsePastedCell(field(3, 'number'), '1,250.5', users)).toBe(1250.5);
    expect(parsePastedCell(field(4, 'boolean'), '是', users)).toBe(true);
  });

  it('builds revision-safe updates and creates rows after the current page', () => {
    const records = [
      {
        id: 9,
        table_id: 1,
        values: {},
        computed_values: {},
        revision: 3,
        created_by: 'user-1',
        updated_by: 'user-1',
        created_at: '',
        updated_at: '',
        deleted_at: null,
      } satisfies TableRecord,
    ];
    expect(
      buildPasteBatch({
        matrix: [
          ['First', '5'],
          ['Second', '6'],
        ],
        startRow: 0,
        startColumn: 0,
        records,
        fields: [field(10, 'text'), field(11, 'number')],
        users,
      }),
    ).toEqual([
      { record_id: 9, revision: 3, values: { '10': 'First', '11': 5 } },
      { values: { '10': 'Second', '11': 6 } },
    ]);
  });
});
