import { describe, expect, it } from 'vitest';
import type { TableField } from '../../lib/api/tables';
import { fromFieldDraft, isoToLocalInput, recordDrafts, toFieldDraft, valuesFromDrafts } from './field-draft';

function field(id: number, type: TableField['type'], config: object = {}): TableField {
  return {
    id,
    table_id: 1,
    name: `F${id}`,
    type,
    required: false,
    is_primary: false,
    config: JSON.stringify(config),
    position: id,
    created_by: 'u1',
    created_at: '2026-10-11T00:00:00.000Z',
    updated_at: '2026-10-11T00:00:00.000Z',
    archived_at: null,
  };
}

describe('field drafts', () => {
  it('keeps typed text as text and parses it only on the way out', () => {
    const number = field(1, 'number');
    expect(toFieldDraft(number, 12.5)).toBe('12.5');
    expect(fromFieldDraft(number, '1.')).toBe(1);
    expect(fromFieldDraft(number, '')).toBeNull();
    expect(fromFieldDraft(number, 'abc')).toBeNull();
  });

  it('round-trips a datetime through the local datetime-local value', () => {
    const datetime = field(2, 'datetime');
    const stored = '2026-10-11T08:30:00.000Z';
    const draft = toFieldDraft(datetime, stored);
    expect(draft).toBe(isoToLocalInput(stored));
    expect(fromFieldDraft(datetime, draft)).toBe(stored);
  });

  it('edits relations as id text, so a half-typed list keeps its separator', () => {
    const many = field(3, 'relation', { relation: { targetTableId: 9, multiple: true } });
    const one = field(4, 'relation', { relation: { targetTableId: 9 } });
    expect(toFieldDraft(many, [12, 13])).toBe('12, 13');
    expect(fromFieldDraft(many, '12, #13, ')).toEqual([12, 13]);
    expect(fromFieldDraft(one, '#7')).toBe(7);
    expect(fromFieldDraft(one, '')).toBeNull();
  });

  it('keeps discrete choices in their stored shape', () => {
    expect(toFieldDraft(field(5, 'boolean'), true)).toBe(true);
    expect(toFieldDraft(field(6, 'multi_user'), ['u1'])).toEqual(['u1']);
    expect(fromFieldDraft(field(6, 'multi_user'), ['u1', 'u2'])).toEqual(['u1', 'u2']);
  });

  it('omits empties on create, clears them on update, and never writes computed fields', () => {
    const fields = [field(1, 'text'), field(2, 'number'), field(3, 'boolean'), field(4, 'formula'), field(5, 'lookup')];
    const drafts = recordDrafts(fields, { values: { '1': 'Hello', '2': null } });
    expect(Object.keys(drafts)).toEqual(['1', '2', '3']);
    expect(valuesFromDrafts(fields, drafts, 'create')).toEqual({ '1': 'Hello', '3': false });
    expect(valuesFromDrafts(fields, drafts, 'update')).toEqual({ '1': 'Hello', '2': null, '3': false });
  });
});
