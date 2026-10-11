import { describe, expect, it } from 'vitest';
import { buildTableCellUserDirectory } from '@greenhouse/types/table-cell-text';
import type { TableField, TableRecord } from '../../lib/api/tables';
import { buildPasteBatch, parseClipboardMatrix, parsePastedCell } from './grid-utils';

const users = [{ id: 'user-1', nickname: 'Jim', email: 'jim@example.com' }];
const ctx = { timeZone: 'Asia/Shanghai', users: buildTableCellUserDirectory(users) };

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

  it("reads typed cells with the import's vocabulary", () => {
    const options = JSON.stringify({ options: [{ id: 'planned', label: 'Planned' }] });
    expect(parsePastedCell(field(1, 'single_select', options), 'Planned', ctx)).toBe('planned');
    expect(parsePastedCell(field(1, 'single_select', options), 'planned', ctx)).toBe('planned');
    expect(parsePastedCell(field(2, 'user'), 'jim@example.com', ctx)).toBe('user-1');
    expect(parsePastedCell(field(2, 'user'), 'Jim', ctx)).toBe('user-1');
    expect(parsePastedCell(field(3, 'number'), '1,250.5', ctx)).toBe(1250.5);
    expect(parsePastedCell(field(4, 'boolean'), '是', ctx)).toBe(true);
    // The review's examples: these imported fine but failed when pasted.
    expect(parsePastedCell(field(4, 'boolean'), '✓', ctx)).toBe(true);
    expect(parsePastedCell(field(4, 'boolean'), 'on', ctx)).toBe(true);
    expect(parsePastedCell(field(3, 'number'), '¥1,200', ctx)).toBe(1200);
    expect(parsePastedCell(field(3, 'number'), '50%', ctx)).toBe(0.5);
    expect(parsePastedCell(field(5, 'date'), '2024年3月5日', ctx)).toBe('2024-03-05');
    expect(parsePastedCell(field(6, 'datetime'), '2024-03-05 10:00', ctx)).toBe('2024-03-05T02:00:00.000Z');
  });

  it('clears on an empty cell, reads link cells as record ids, and names the field in a refusal', () => {
    expect(parsePastedCell(field(3, 'number'), '  ', ctx)).toBeNull();
    expect(parsePastedCell(field(7, 'relation', JSON.stringify({ relation: { targetTableId: 2 } })), '#12', ctx)).toBe(
      12,
    );
    expect(
      parsePastedCell(
        field(7, 'relation', JSON.stringify({ relation: { targetTableId: 2, multiple: true } })),
        '12, #13',
        ctx,
      ),
    ).toEqual([12, 13]);
    expect(() => parsePastedCell(field(7, 'relation'), 'Acme', ctx)).toThrow('Field 7: "Acme" is not a record id');
    expect(() => parsePastedCell(field(3, 'number'), '1,5', ctx)).toThrow('Field 3: "1,5" is not a number');
    expect(() => parsePastedCell(field(8, 'formula'), '3', ctx)).toThrow('Field 8: computed fields cannot be written');
  });

  it('reads 03/04 day-first only when the pasted column has a day-first date', () => {
    const batch = (column: string[]) =>
      buildPasteBatch({
        matrix: column.map((cell) => [cell]),
        startRow: 0,
        startColumn: 0,
        records: [],
        fields: [field(5, 'date')],
        users,
        timeZone: 'UTC',
      }).map((item) => item.values['5']);
    expect(batch(['03/04/2024'])).toEqual(['2024-03-04']);
    expect(batch(['03/04/2024', '25/12/2024'])).toEqual(['2024-04-03', '2024-12-25']);
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
        timeZone: 'UTC',
      }),
    ).toEqual([
      { record_id: 9, revision: 3, values: { '10': 'First', '11': 5 } },
      { values: { '10': 'Second', '11': 6 } },
    ]);
  });
});
