/**
 * The phone's field rules (./fields.ts): how values read, which control edits
 * which type, and what a form sends — the same verdicts as the web's
 * FieldValue / FieldEditor and the server's value validator.
 */

import { describe, expect, it } from 'vitest';

import {
  changedValues,
  controlFor,
  draftValue,
  fieldConfig,
  missingRequired,
  numberDraftValid,
  recordTitle,
  recordValue,
  valueChips,
  valueText,
  wireValue,
  type FieldLike,
  type ValueLabels,
} from './fields';

const field = (id: number, type: string, config: unknown = '{}', extra: Partial<FieldLike> = {}): FieldLike => ({
  id,
  name: `f${id}`,
  type,
  config,
  ...extra,
});

const status = field(
  2,
  'single_select',
  JSON.stringify({
    options: [
      { id: 'open', label: 'Open' },
      { id: 'done', label: 'Done' },
    ],
  }),
);
const tags = field(3, 'multi_select', {
  options: [
    { id: 'a', label: 'Alpha' },
    { id: 'b', label: 'Beta' },
  ],
});
const owner = field(4, 'user');
const amount = field(5, 'number');
const due = field(6, 'date');
const vendor = field(7, 'relation', { relation: { targetTableId: 9 } });
const vendors = field(8, 'relation', { relation: { targetTableId: 9, multiple: true } });
const total = field(10, 'formula', { formula: { resultType: 'number', expression: {} } });
const title = field(1, 'text', '{}', { is_primary: true, required: true });

const labels: ValueLabels = {
  user: (id) => ({ u1: 'Ada', u2: 'Lin' })[id],
  record: (tableId, id) => (tableId === 9 ? ({ 1: 'Acme', 2: null } as Record<number, string | null>)[id] : undefined),
  yes: 'Yes',
  no: 'No',
  noAccess: 'No access',
  locale: 'en-US',
};

describe('reading values', () => {
  it('reads AI results by their result type and resolves the AI field’s option labels', () => {
    const ai = field(12, 'ai', { ai: { resultType: 'single_select', options: [{ id: 'yes', label: 'Accepted' }] } });
    expect(valueText(ai, 'yes', labels)).toBe('Accepted');
    expect(valueText(field(13, 'ai', { ai: { resultType: 'number' } }), 12345, labels)).toBe('12,345');
    expect(controlFor(ai)).toBe('readonly');
    expect(changedValues([ai], new Set([12]), { '12': 'yes' }, { '12': 'no' }, { create: false })).toEqual({});
  });
  it('parses JSON-encoded and object configs alike', () => {
    expect(fieldConfig(status).options?.[1]?.label).toBe('Done');
    expect(fieldConfig(tags).options?.length).toBe(2);
    expect(fieldConfig(field(1, 'text', '{bad'))).toEqual({});
  });

  it('prefers the computed value', () => {
    expect(recordValue({ values: { '10': 1 }, computed_values: { '10': 42 } }, 10)).toBe(42);
    expect(recordValue({ values: { '5': 3 } }, 5)).toBe(3);
  });

  it('reads every type as one line, with grouped numbers and labelled options / people / related rows', () => {
    expect(valueText(status, 'done', labels)).toBe('Done');
    expect(valueText(tags, ['b', 'a'], labels)).toBe('Beta, Alpha');
    expect(valueText(owner, 'u2', labels)).toBe('Lin');
    expect(valueText(amount, 760000.5, labels)).toBe('760,000.5');
    expect(valueText(total, 1234, labels)).toBe('1,234');
    expect(valueText(due, '2026-03-01', labels)).toBe('Mar 1, 2026');
    expect(valueText(field(9, 'boolean'), true, labels)).toBe('Yes');
    expect(valueText(amount, null, labels)).toBe('');
    // a related row outside the reader's scope is named as such, an unknown one by its id
    expect(valueChips(vendors, [1, 2, 3], labels)).toEqual(['Acme', 'No access', '#3']);
    expect(valueChips(vendor, 1, labels)).toEqual(['Acme']);
  });

  it('titles a record with its primary field, else its id', () => {
    expect(recordTitle({ id: 7, values: { '1': 'Laptops' } }, [title, amount], labels)).toBe('Laptops');
    expect(recordTitle({ id: 7, values: {} }, [title, amount], labels)).toBe('#7');
  });
});

describe('editing', () => {
  it('maps each type onto one control; computed fields are read-only', () => {
    expect(controlFor(field(1, 'email'))).toBe('text');
    expect(controlFor(field(1, 'long_text'))).toBe('long_text');
    expect(controlFor(total)).toBe('readonly');
    expect(controlFor(field(1, 'lookup'))).toBe('readonly');
    expect(controlFor(vendors)).toBe('relation');
  });

  it('round-trips drafts to the values the server accepts', () => {
    expect(wireValue(amount, draftValue(amount, 12.5))).toBe(12.5);
    expect(wireValue(amount, '1,200')).toBe(1200);
    expect(wireValue(amount, '')).toBeNull();
    expect(numberDraftValid('12a')).toBe(false);
    expect(wireValue(title, '  ')).toBeNull();
    // a single relation is one record id, a multiple one an array
    expect(wireValue(vendor, draftValue(vendor, 4))).toBe(4);
    expect(wireValue(vendors, draftValue(vendors, [4, 5]))).toEqual([4, 5]);
    expect(wireValue(tags, [])).toBeNull();
    expect(wireValue(due, '2026-03-01')).toBe('2026-03-01');
  });

  it('sends only what changed, and only editable fields', () => {
    const fields = [title, status, amount];
    const editable = new Set([1, 2]);
    const initial = { '1': 'Laptops', '2': 'open', '5': '3' };
    expect(
      changedValues(fields, editable, initial, { '1': 'Laptops', '2': 'done', '5': '9' }, { create: false }),
    ).toEqual({ '2': 'done' });
    expect(changedValues(fields, new Set([1, 2, 5]), {}, { '1': 'New', '2': null, '5': '' }, { create: true })).toEqual(
      {
        '1': 'New',
      },
    );
  });

  it('asks only for required fields the writer may edit', () => {
    expect(missingRequired([title, amount], new Set([1]), { '1': '' }).map((f) => f.id)).toEqual([1]);
    expect(missingRequired([title, amount], new Set([5]), { '1': '' })).toEqual([]);
  });
});
