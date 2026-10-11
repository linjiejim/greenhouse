/**
 * Import-only cell handling: linked records by primary text, column inference,
 * header matching and new select options. Everything else an import cell can
 * hold is read by `@greenhouse/types/table-cell-text` (tested there, shared
 * with the grid's paste).
 */

import { describe, expect, it } from 'vitest';
import { buildTableCellUserDirectory } from '@greenhouse/types/table-cell-text';
import type { TableFieldType } from '@greenhouse/types/tables';
import {
  coerceImportValue,
  inferImportColumnType,
  matchImportHeader,
  missingSelectLabels,
  withImportedOptions,
  type ImportField,
  type ImportValueContext,
} from '../import-values.js';

function field(type: TableFieldType, config: ImportField['config'] = {}): ImportField {
  return { id: 7, name: 'Col', type, config };
}

const ctx: ImportValueContext = {
  timeZone: 'Asia/Shanghai',
  users: buildTableCellUserDirectory([{ id: 'u-ada', email: 'ada@example.com', nickname: 'Ada' }]),
  relationLabels: new Map([
    ['Acme', [11]],
    ['Globex', [12]],
    ['Twin', [13, 14]],
  ]),
};

function value(type: TableFieldType, raw: string, config: ImportField['config'] = {}, context = ctx) {
  const result = coerceImportValue(field(type, config), raw, context);
  return result.ok ? result.value : { error: result.error };
}

const STATUS = {
  options: [
    { id: 'todo', label: 'To do' },
    { id: 'done', label: 'Done' },
    { id: 'red-dark', label: 'Red, dark' },
    { id: 'urgent', label: '（急）' },
  ],
};

describe('coerceImportValue', () => {
  it('links records by exact primary text within the readable labels only', () => {
    const single = { relation: { targetTableId: 2 } };
    const multiple = { relation: { targetTableId: 2, multiple: true } };
    expect(value('relation', '  ', single)).toBeUndefined();
    expect(value('relation', 'Acme', single)).toBe(11);
    expect(value('relation', 'Acme, Globex', multiple)).toEqual([11, 12]);
    expect(value('relation', 'acme', single)).toEqual({ error: 'Col: no linked record named "acme"' });
    expect(value('relation', 'Twin', single)).toEqual({ error: 'Col: "Twin" matches several linked records' });
    expect(value('relation', 'Acme', single, { ...ctx, relationLabels: undefined })).toEqual({
      error: 'Col: the linked table is not available to you',
    });
  });

  it('reads every other type through the shared cell-text coercer', () => {
    expect(value('boolean', '✓')).toBe(true);
    expect(value('number', '¥1,200')).toBe(1200);
    expect(value('number', '50%')).toBe(0.5);
    expect(value('single_select', 'done', STATUS)).toBe('done');
    expect(value('user', 'Ada')).toBe('u-ada');
    expect(value('datetime', '2024-03-05 10:00')).toBe('2024-03-05T02:00:00.000Z');
    expect(value('text', '   ')).toBeUndefined();
    expect(value('attachment', '12')).toEqual({ error: 'Col: files cannot be read from text' });
  });
});

describe('column helpers', () => {
  it('infers the type a new field should get', () => {
    expect(inferImportColumnType(['1', '2,000', '', '3.5'])).toBe('number');
    expect(inferImportColumnType(['是', '否', '是'])).toBe('boolean');
    expect(inferImportColumnType(['2024-01-02', '2024/2/3'])).toBe('date');
    expect(inferImportColumnType(['2024-01-02 10:00', '2024-01-03'])).toBe('datetime');
    expect(inferImportColumnType(['a@example.com', 'b@example.com'])).toBe('email');
    expect(inferImportColumnType(['https://a.example', 'www.b.example'])).toBe('url');
    expect(inferImportColumnType(['Open', 'Closed', 'Open', 'Open', 'Closed'])).toBe('single_select');
    expect(inferImportColumnType(['first line\nsecond', 'x'])).toBe('long_text');
    expect(inferImportColumnType(['Ada', 'Grace', 'Linus'])).toBe('text');
    expect(inferImportColumnType(['', ' '])).toBe('text');
  });

  it('matches headers to field names ignoring case, width and spacing', () => {
    const fields = [{ name: 'Due date' }, { name: 'Owner' }, { name: 'owner ' }];
    expect(matchImportHeader('due_date', fields)).toEqual({ name: 'Due date' });
    expect(matchImportHeader('ＤＵＥ  ＤＡＴＥ', fields)).toEqual({ name: 'Due date' });
    // Two fields answer to "owner": ambiguous, no suggestion.
    expect(matchImportHeader('Owner', fields)).toBeUndefined();
    expect(matchImportHeader('', fields)).toBeUndefined();
  });

  it('lists missing select labels and adds them as options with unique ids', () => {
    const status = field('multi_select', STATUS);
    expect(missingSelectLabels(status, 'Done, Later, 稍后')).toEqual(['Later', '稍后']);
    const options = withImportedOptions(STATUS.options, ['Later', '稍后', 'later', 'x'.repeat(101)]);
    expect(options.slice(4)).toEqual([
      { id: 'later-5', label: 'Later' },
      { id: 'option-6', label: '稍后' },
    ]);
    const full = withImportedOptions(
      Array.from({ length: 99 }, (_, index) => ({ id: `o${index}`, label: `L${index}` })),
      ['A', 'B'],
    );
    expect(full).toHaveLength(100);
  });
});
