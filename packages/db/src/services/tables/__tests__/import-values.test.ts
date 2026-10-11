/**
 * Import cell coercion — every field type, as a matrix of what spreadsheets
 * really contain, plus column inference and header matching.
 */

import { describe, expect, it } from 'vitest';
import type { TableFieldType } from '@greenhouse/types/tables';
import {
  buildImportUserDirectory,
  coerceImportValue,
  inferImportColumnType,
  inferImportDateOrder,
  matchImportHeader,
  missingSelectLabels,
  parseImportDate,
  parseImportDateTime,
  parseImportNumber,
  withImportedOptions,
  type ImportField,
  type ImportValueContext,
} from '../import-values.js';

function field(type: TableFieldType, config: ImportField['config'] = {}): ImportField {
  return { id: 7, name: 'Col', type, config };
}

const users = buildImportUserDirectory([
  { id: 'u-ada', email: 'Ada@Example.com', nickname: 'Ada' },
  { id: 'u-li', email: 'li@example.com', nickname: '李雷' },
  { id: 'u-sam1', email: 'sam1@example.com', nickname: 'Sam' },
  { id: 'u-sam2', email: 'sam2@example.com', nickname: 'sam' },
]);

const ctx: ImportValueContext = {
  timeZone: 'Asia/Shanghai',
  users,
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
  it('leaves empty cells unset for every type', () => {
    for (const type of ['text', 'number', 'date', 'single_select', 'user', 'relation'] as const) {
      expect(value(type, '   ')).toBeUndefined();
    }
  });

  it('reads numbers with thousands separators, currency, parentheses and percent', () => {
    expect(value('number', '1,234.5')).toBe(1234.5);
    expect(value('number', '12,345,678')).toBe(12345678);
    expect(value('number', ' -42 ')).toBe(-42);
    expect(value('number', '(1,200)')).toBe(-1200);
    expect(value('number', '¥ 99.9')).toBe(99.9);
    expect(value('number', '$1,000')).toBe(1000);
    expect(value('number', '100元')).toBe(100);
    expect(value('number', '12.5%')).toBe(0.125);
    expect(value('number', '1 234')).toBe(1234);
    expect(value('number', '１２３')).toBe(123);
    expect(value('number', '1e3')).toBe(1000);
    // A comma is never a decimal point.
    expect(value('number', '1,5')).toEqual({ error: 'Col: "1,5" is not a number' });
    expect(value('number', 'abc')).toEqual({ error: 'Col: "abc" is not a number' });
  });

  it('reads yes / no in English and Chinese', () => {
    for (const raw of ['true', 'YES', 'y', '1', '✓', '是', '对']) expect(value('boolean', raw)).toBe(true);
    for (const raw of ['false', 'No', 'n', '0', '否', '不是', '无']) expect(value('boolean', raw)).toBe(false);
    expect(value('boolean', 'maybe')).toEqual({ error: 'Col: "maybe" is not yes / no' });
  });

  it('reads dates in common spellings as YYYY-MM-DD', () => {
    expect(value('date', '2024-03-05')).toBe('2024-03-05');
    expect(value('date', '2024/3/5')).toBe('2024-03-05');
    expect(value('date', '2024.03.05')).toBe('2024-03-05');
    expect(value('date', '2024年3月5日')).toBe('2024-03-05');
    expect(value('date', '20240305')).toBe('2024-03-05');
    expect(value('date', '03/05/2024')).toBe('2024-03-05');
    expect(value('date', '25/12/2024')).toBe('2024-12-25');
    expect(value('date', '05/03/2024', {}, { ...ctx, dateOrder: 'dmy' })).toBe('2024-03-05');
    expect(value('date', '5 Mar 2024')).toBe('2024-03-05');
    expect(value('date', '05-Mar-24')).toBe('2024-03-05');
    expect(value('date', 'March 5th, 2024')).toBe('2024-03-05');
    expect(value('date', 'Sept 1, 2024')).toBe('2024-09-01');
    expect(value('date', '2024-03-05 14:30')).toBe('2024-03-05');
    expect(value('date', '2024-02-30')).toEqual({ error: 'Col: "2024-02-30" is not a date' });
    expect(value('date', 'soon')).toEqual({ error: 'Col: "soon" is not a date' });
  });

  it('reads datetimes: offsets are exact, naive times are in the importer zone', () => {
    expect(value('datetime', '2024-03-05T10:00:00Z')).toBe('2024-03-05T10:00:00.000Z');
    expect(value('datetime', '2024-03-05 10:00+0800')).toBe('2024-03-05T02:00:00.000Z');
    expect(value('datetime', '2024-03-05 10:00')).toBe('2024-03-05T02:00:00.000Z');
    expect(value('datetime', '2024/3/5 下午3:30')).toBe('2024-03-05T07:30:00.000Z');
    expect(value('datetime', '03/05/2024 3:30 PM')).toBe('2024-03-05T07:30:00.000Z');
    expect(value('datetime', '2024-03-05')).toBe('2024-03-04T16:00:00.000Z');
    expect(value('datetime', '2024-03-05 25:00')).toEqual({ error: 'Col: "2024-03-05 25:00" is not a date and time' });
  });

  it('applies the zone across a daylight-saving change', () => {
    // New York switched to EDT (UTC-4) at 02:00 on 2024-03-10.
    const ny = { ...ctx, timeZone: 'America/New_York' };
    expect(value('datetime', '2024-03-09 12:00', {}, ny)).toBe('2024-03-09T17:00:00.000Z');
    expect(value('datetime', '2024-03-10 12:00', {}, ny)).toBe('2024-03-10T16:00:00.000Z');
  });

  it('matches select options by label, case-insensitively, or by id', () => {
    expect(value('single_select', 'Done', STATUS)).toBe('done');
    expect(value('single_select', ' to DO ', STATUS)).toBe('todo');
    expect(value('single_select', 'todo', STATUS)).toBe('todo');
    expect(value('single_select', '（急）', STATUS)).toBe('urgent');
    expect(value('single_select', 'Later', STATUS)).toEqual({ error: 'Col: "Later" is not an option' });
  });

  it('splits multi-select cells on , ; and 、 unless the whole cell is one label', () => {
    expect(value('multi_select', 'To do, Done', STATUS)).toEqual(['todo', 'done']);
    expect(value('multi_select', 'Done；To do', STATUS)).toEqual(['done', 'todo']);
    expect(value('multi_select', 'Done、Done', STATUS)).toEqual(['done']);
    expect(value('multi_select', 'Red, dark', STATUS)).toEqual(['red-dark']);
    expect(value('multi_select', 'Done, Nope', STATUS)).toEqual({ error: 'Col: "Nope" is not an option' });
  });

  it('matches members by email or a unique name', () => {
    expect(value('user', 'ada@example.com')).toBe('u-ada');
    expect(value('user', 'mailto:ADA@example.com')).toBe('u-ada');
    expect(value('user', 'Ada')).toBe('u-ada');
    expect(value('user', '李雷')).toBe('u-li');
    expect(value('user', 'u-li')).toBe('u-li');
    expect(value('user', 'Sam')).toEqual({ error: 'Col: "Sam" matches several members — use their email' });
    expect(value('user', 'Nobody')).toEqual({ error: 'Col: no member named "Nobody"' });
    expect(value('multi_user', 'Ada、li@example.com')).toEqual(['u-ada', 'u-li']);
  });

  it('normalizes web addresses, email addresses and phone numbers', () => {
    expect(value('url', 'https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(value('url', 'www.example.com')).toBe('https://www.example.com');
    expect(value('url', 'javascript:alert(1)')).toEqual({ error: 'Col: "javascript:alert(1)" is not a web address' });
    expect(value('url', 'not a link')).toEqual({ error: 'Col: "not a link" is not a web address' });
    expect(value('email', 'mailto:Ada@example.com')).toBe('Ada@example.com');
    expect(value('email', 'ada@')).toEqual({ error: 'Col: "ada@" is not an email address' });
    expect(value('phone', ' +86 138 0000 0000 ')).toBe('+86 138 0000 0000');
  });

  it('links records by exact primary text within the readable labels only', () => {
    const single = { relation: { targetTableId: 2 } };
    const multiple = { relation: { targetTableId: 2, multiple: true } };
    expect(value('relation', 'Acme', single)).toBe(11);
    expect(value('relation', 'Acme, Globex', multiple)).toEqual([11, 12]);
    expect(value('relation', 'acme', single)).toEqual({ error: 'Col: no linked record named "acme"' });
    expect(value('relation', 'Twin', single)).toEqual({ error: 'Col: "Twin" matches several linked records' });
    expect(value('relation', 'Acme', single, { ...ctx, relationLabels: undefined })).toEqual({
      error: 'Col: the linked table is not available to you',
    });
  });

  it('keeps text as written and refuses attachments and computed fields', () => {
    expect(value('text', '  ＡＢＣ  ')).toBe('ＡＢＣ');
    expect(value('long_text', 'line 1\nline 2')).toBe('line 1\nline 2');
    expect(value('text', 'x'.repeat(10_001))).toEqual({ error: 'Col: longer than 10,000 characters' });
    expect(value('attachment', '12')).toEqual({ error: 'Col: attachments cannot be imported' });
    expect(value('formula', '12')).toEqual({ error: 'Col: computed fields cannot be imported' });
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

  it('decides the day / month order per column', () => {
    expect(inferImportDateOrder(['03/04/2024', '13/04/2024'])).toBe('dmy');
    expect(inferImportDateOrder(['03/04/2024', '04/13/2024'])).toBe('mdy');
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

  it('exposes the parsers for previews', () => {
    expect(parseImportNumber('n/a')).toBeNull();
    expect(parseImportDate('2024-13-01')).toBeNull();
    expect(parseImportDateTime('2024-03-05T10:00', 'UTC')).toBe('2024-03-05T10:00:00.000Z');
  });
});
