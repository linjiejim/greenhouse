/**
 * Form config / audience shapes (slice Fm, spec 20261011-tables-foundation §3):
 * pure normalization that runs before anything touches the database.
 */

import { describe, expect, it } from 'vitest';
import type { TableFormConfig } from '@greenhouse/types/tables';
import { formDefaultEntries, formUploadKeySegment, formWritableFieldIds, normalizeFormAudience } from '../forms.js';
import { TablesValidationError } from '../shared.js';

describe('normalizeFormAudience', () => {
  it('defaults to the Base and keeps team as is', () => {
    expect(normalizeFormAudience(undefined)).toEqual({ type: 'base' });
    expect(normalizeFormAudience({ type: 'team', userIds: ['ignored'] })).toEqual({ type: 'team' });
  });

  it('dedupes principals and refuses an empty or malformed list', () => {
    expect(normalizeFormAudience({ type: 'principals', userIds: ['u1', 'u1'], groupIds: [3, 3, 4] })).toEqual({
      type: 'principals',
      userIds: ['u1'],
      groupIds: [3, 4],
    });
    expect(() => normalizeFormAudience({ type: 'principals', userIds: [], groupIds: [] })).toThrow(
      TablesValidationError,
    );
    expect(() => normalizeFormAudience({ type: 'principals', userIds: [1], groupIds: [] })).toThrow(
      TablesValidationError,
    );
    expect(() => normalizeFormAudience({ type: 'principals', userIds: [], groupIds: [0] })).toThrow(
      TablesValidationError,
    );
    expect(() => normalizeFormAudience({ type: 'public' })).toThrow(TablesValidationError);
  });
});

describe('form defaults', () => {
  it('reads the array form and the legacy {fieldId: value} object alike', () => {
    expect(formDefaultEntries({ defaults: [{ fieldId: 7, value: '$me' }] })).toEqual([{ fieldId: 7, value: '$me' }]);
    const legacy = { defaults: { '7': '$me', '8': 'Fixed', nope: 1 } } as unknown as TableFormConfig;
    expect(formDefaultEntries(legacy)).toEqual([
      { fieldId: 7, value: '$me' },
      { fieldId: 8, value: 'Fixed' },
    ]);
    expect(formDefaultEntries(undefined)).toEqual([]);
  });

  it('writes the shown fields and the prefilled ones', () => {
    expect(formWritableFieldIds({ fieldIds: [1, 2], defaults: [{ fieldId: 9, value: 'x' }] })).toEqual([1, 2, 9]);
  });

  it('files form uploads under the segment the upload route writes', () => {
    expect(formUploadKeySegment(5, 12)).toBe('tables/5/forms/12/');
  });
});
