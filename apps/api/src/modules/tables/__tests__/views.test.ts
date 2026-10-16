import { describe, expect, it } from 'vitest';
import type { BaseFieldRow } from '@greenhouse/db';
import { canChangeType, convertValue, normalizeConfig, normalizeValue, emptyRefs } from '../values.js';
import { cleanConfig, defaultConfig } from '../views.js';
import { resolveDay } from '../query.js';

const field = (id: string, type: BaseFieldRow['type'], extra: Partial<BaseFieldRow> = {}): BaseFieldRow => ({
  id,
  tableId: 'tbl_1',
  name: id,
  type,
  required: false,
  isPrimary: false,
  config: {},
  position: 0,
  createdBy: null,
  archivedAt: null,
  createdAt: '',
  updatedAt: '',
  ...extra,
});

const fields = [
  field('title', 'text', { isPrimary: true }),
  field('status', 'single_select', { config: { options: [{ id: 'a', label: 'A', color: 'gray' }] } }),
  field('owner', 'member'),
  field('start', 'date'),
  field('end', 'date'),
  field('deps', 'dependency'),
  field('files', 'attachment'),
  field('notes', 'long_text'),
];

describe('defaultConfig', () => {
  it('fills a view in from the table: lanes, dates, covers and the dependency field', () => {
    expect(defaultConfig('kanban', fields)?.kanban).toEqual({ field: 'status' });
    expect(defaultConfig('calendar', fields)?.calendar).toEqual({ start: 'start' });
    expect(defaultConfig('gallery', fields)?.gallery).toEqual({ cover: 'files' });
    expect(defaultConfig('timeline', fields)?.timeline).toEqual({
      start: 'start',
      end: 'end',
      dependency: 'deps',
      scale: 'week',
    });
    // The primary field and five more show; the rest start hidden.
    expect(defaultConfig('grid', fields)).toEqual({ hidden: ['files', 'notes'] });
    expect(defaultConfig('kanban', [fields[0]!])).toBeNull();
  });
});

describe('cleanConfig', () => {
  it('drops what refers to fields that are gone and refuses settings that do not fit', () => {
    const config = {
      filter: { mode: 'and' as const, clauses: [{ field: 'gone', op: 'eq' as const, value: 1 }] },
      sorts: [{ field: 'start' }, { field: 'gone' }],
      hidden: ['title', 'notes', 'gone'],
      widths: { gone: 100, notes: 200 },
    };
    expect(cleanConfig('grid', config, fields)).toEqual({
      sorts: [{ field: 'start' }],
      hidden: ['notes'],
      widths: { notes: 200 },
    });
    expect(() => cleanConfig('grid', { sorts: [{ field: 'deps' }] }, fields)).toThrow();
    expect(cleanConfig('grid', { sorts: [{ field: 'deps' }] }, fields, 'lenient')).toEqual({});
    expect(() => cleanConfig('kanban', { kanban: { field: 'notes' } }, fields)).toThrow();
    expect(
      cleanConfig(
        'timeline',
        { timeline: { start: 'start', end: 'start', milestone: { field: 'status', option: 'x' } } },
        fields,
      ),
    ).toEqual({ timeline: { start: 'start', scale: 'week' } });
  });
});

describe('values', () => {
  it('keeps a field’s settings to its type and checks values against them', () => {
    expect(normalizeConfig('member', { multiple: true, precision: 2 })).toEqual({ multiple: true });
    expect(normalizeConfig('relation', { table_id: 'tbl_2' })).toEqual({ table_id: 'tbl_2', multiple: true });
    expect(() => normalizeConfig('relation', {})).toThrow();
    expect(() =>
      normalizeConfig('single_select', {
        options: [
          { id: 'a', label: 'A', color: 'gray' },
          { id: 'a', label: 'B', color: 'gray' },
        ],
      }),
    ).toThrow();
    const refs = emptyRefs();
    expect(normalizeValue(fields[2]!, 'mbr_a', refs)).toEqual(['mbr_a']);
    expect(() => normalizeValue(fields[2]!, ['mbr_a', 'mbr_b'], refs)).toThrow();
    expect(normalizeValue(fields[0]!, '', refs)).toBeNull();
    expect(normalizeValue(field('done', 'checkbox'), null, refs)).toBe(false);
    expect(normalizeValue(field('when', 'datetime'), '2026-10-16T09:30:00+08:00', refs)).toBe(
      '2026-10-16T01:30:00.000Z',
    );
    expect(() => normalizeValue(field('site', 'url'), 'javascript:alert(1)', refs)).toThrow();
    expect(normalizeValue(fields[5]!, ['rec_a'], refs)).toEqual(['rec_a']);
    expect(refs.records.get('tbl_1')).toEqual(new Set(['rec_a']));
  });

  it('changes a type only where values carry over', () => {
    expect(canChangeType('text', 'url')).toBe(true);
    expect(canChangeType('single_select', 'multi_select')).toBe(true);
    expect(canChangeType('number', 'text')).toBe(false);
    expect(convertValue('single_select', 'multi_select', 'a')).toEqual(['a']);
    expect(convertValue('date', 'datetime', '2026-10-16')).toBe('2026-10-16T00:00:00.000Z');
  });
});

describe('resolveDay', () => {
  it('reads the day tokens in the reader’s zone', () => {
    const now = new Date('2026-10-15T17:00:00.000Z'); // Friday 16 October in Shanghai
    const ctx = { timeZone: 'Asia/Shanghai', now };
    expect(resolveDay('$today', ctx)).toBe('2026-10-16');
    expect(resolveDay('$yesterday', ctx)).toBe('2026-10-15');
    expect(resolveDay('$tomorrow', ctx)).toBe('2026-10-17');
    expect(resolveDay('$week_start', ctx)).toBe('2026-10-12');
    expect(resolveDay('$month_start', ctx)).toBe('2026-10-01');
    expect(resolveDay('2026-01-02', ctx)).toBe('2026-01-02');
    expect(resolveDay('soon', ctx)).toBeNull();
  });
});
