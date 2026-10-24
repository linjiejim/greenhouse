import { describe, expect, it } from 'vitest';
import type { TableField, TableRecord } from '../shared/greenhouse-types';
import {
  canAddRecords,
  cellValue,
  displayValue,
  draftValues,
  liveFields,
  quickAddFields,
  keptUserNames,
  recordTitle,
  recordUserIds,
  recordUserNames,
  selectOptions,
} from './table-fields';

const field = (id: number, type: string, over: Partial<TableField> = {}): TableField => ({
  id,
  table_id: 1,
  name: `F${id}`,
  type,
  required: false,
  is_primary: false,
  config: null,
  position: id,
  archived_at: null,
  ...over,
});
const options = JSON.stringify({ options: [{ id: 'o1', label: 'Open' }, { id: 'o2', label: 'Won', color: '#0a0' }] });
const words = { yes: 'Yes', no: 'No', date: (v: string) => `d:${v}`, user: (id: string) => (id === 'u1' ? 'Maya' : id) };
const record = (values: Record<string, unknown>, computed: Record<string, unknown> = {}): TableRecord => ({
  id: 7,
  table_id: 1,
  values,
  computed_values: computed,
  revision: 1,
  created_by: 'u1',
  updated_by: null,
  created_at: '',
  updated_at: '',
});

describe('table fields', () => {
  it('orders live fields with the primary first', () => {
    const fields = [field(1, 'text', { position: 2 }), field(2, 'text', { is_primary: true, position: 5 }), field(3, 'text', { archived_at: 'x' })];
    expect(liveFields(fields).map((f) => f.id)).toEqual([2, 1]);
  });

  it('reads select options and ignores broken config', () => {
    expect(selectOptions({ config: options }).map((o) => o.label)).toEqual(['Open', 'Won']);
    expect(selectOptions({ config: '{nope' })).toEqual([]);
  });

  it('reads each type as text', () => {
    expect(displayValue(field(1, 'boolean'), true, words)).toBe('Yes');
    expect(displayValue(field(1, 'boolean'), false, words)).toBe('No');
    expect(displayValue(field(1, 'number'), 3.5, words)).toBe('3.5');
    expect(displayValue(field(1, 'number'), 91000, words)).toBe('91,000');
    expect(displayValue(field(1, 'date'), '2026-10-24', words)).toBe('d:2026-10-24');
    expect(displayValue(field(1, 'single_select', { config: options }), 'o2', words)).toBe('Won');
    expect(displayValue(field(1, 'multi_select', { config: options }), ['o1', 'o2', 'gone'], words)).toBe('Open, Won');
    expect(displayValue(field(1, 'multi_user'), ['u1', 'u2'], words)).toBe('Maya, u2');
    expect(displayValue(field(1, 'relation'), [3, 4], words)).toBe('#3, #4');
    expect(displayValue(field(1, 'text'), null, words)).toBe('');
    expect(displayValue(field(1, 'long_text'), { odd: true }, words)).toBe('');
  });

  it('prefers a computed result and titles a record by its primary field', () => {
    const f = field(4, 'formula');
    expect(cellValue(f, record({ '4': 1 }, { '4': 2 }))).toBe(2);
    const fields = [field(1, 'text', { is_primary: true })];
    expect(recordTitle(fields, record({ '1': 'Acme' }), words)).toBe('Acme');
    expect(recordTitle(fields, record({}), words)).toBe('#7');
  });
});

describe('quick add', () => {
  const fields = [
    field(1, 'text', { is_primary: true, required: true }),
    field(2, 'number'),
    field(3, 'date'),
    field(4, 'single_select', { config: options }),
    field(5, 'boolean'),
    field(6, 'formula'),
    field(7, 'user'),
  ];

  it('offers only the simple types', () => {
    expect(quickAddFields(fields).map((f) => f.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('builds values and leaves empty optional fields out', () => {
    expect(draftValues(fields, { '1': ' Acme ', '2': '1,200', '3': '2026-10-24', '4': 'o2' })).toEqual({
      ok: true,
      values: { '1': 'Acme', '2': 1200, '3': '2026-10-24', '4': 'o2', '5': false },
    });
    expect(draftValues(fields, { '1': 'A', '4': 'unknown', '5': true })).toEqual({ ok: true, values: { '1': 'A', '5': true } });
  });

  it('names the first problem', () => {
    expect(draftValues(fields, {})).toEqual({ ok: false, problem: { kind: 'required', field: 'F1' } });
    expect(draftValues(fields, { '1': 'A', '2': 'twelve' })).toEqual({ ok: false, problem: { kind: 'number', field: 'F2' } });
    expect(draftValues(fields, { '1': 'A', '3': '24/10/2026' })).toEqual({ ok: false, problem: { kind: 'date', field: 'F3' } });
  });

  it('lets editors and up add records', () => {
    expect(['owner', 'builder', 'editor', 'viewer', undefined].map(canAddRecords)).toEqual([true, true, true, false, false]);
  });
});

describe('the names kept with a record’s offline copy', () => {
  const users = [
    { id: 'usr_maya', nickname: 'Maya' },
    { id: 'usr_li', nickname: 'Li' },
    { id: 'usr_sam', nickname: 'Sam' },
    { id: 'usr_anon', nickname: null },
  ];

  it('keeps only the people the record’s user fields name', () => {
    const fields = [field(1, 'text'), field(2, 'user'), field(3, 'multi_user')];
    const record = { values: { '1': 'usr_sam', '2': 'usr_maya', '3': ['usr_li', 'usr_anon', 7] }, computed_values: {} };
    expect(recordUserNames(fields, record, users)).toEqual({ usr_maya: 'Maya', usr_li: 'Li' });
  });

  it('is empty when the record names nobody', () => {
    expect(recordUserNames([field(2, 'user')], { values: {}, computed_values: {} }, users)).toEqual({});
    expect(recordUserNames([field(1, 'text')], { values: { '1': 'usr_maya' }, computed_values: {} }, users)).toEqual({});
  });
});

describe('the people a record names', () => {
  it('lists each user id its user fields name once, in field order', () => {
    const fields = [field(1, 'text'), field(2, 'user'), field(3, 'multi_user')];
    const record = { values: { '1': 'usr_sam', '2': 'usr_li', '3': ['usr_maya', 'usr_li', 7] }, computed_values: {} };
    expect(recordUserIds(fields, record)).toEqual(['usr_li', 'usr_maya']);
  });

  it('keeps an earlier copy’s names only for the people the record still names', () => {
    expect(keptUserNames(['usr_maya', 'usr_new'], { usr_maya: 'Maya', usr_gone: 'Gone' })).toEqual({ usr_maya: 'Maya' });
    expect(keptUserNames([], { usr_maya: 'Maya' })).toEqual({});
  });
});
