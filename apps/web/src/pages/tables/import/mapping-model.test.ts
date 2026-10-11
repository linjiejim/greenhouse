import { describe, expect, it } from 'vitest';
import type { TableImportColumn } from '@greenhouse/types/tables';
import type { TableField } from '../../../lib/api/tables';
import {
  columnLetter,
  columnSamples,
  destinationFromValue,
  initialDestinations,
  mappingProblems,
  mappingRequest,
} from './mapping-model';

const stamp = '2026-10-11T00:00:00.000Z';
const field = (id: number, name: string): TableField => ({
  id,
  table_id: 1,
  name,
  type: 'text',
  required: false,
  is_primary: false,
  config: '{}',
  position: id,
  created_by: 'u1',
  created_at: stamp,
  updated_at: stamp,
  archived_at: null,
});

const column = (index: number, header: string, extra: Partial<TableImportColumn> = {}): TableImportColumn => ({
  index,
  header,
  samples: ['a', 'b'],
  inferredType: 'text',
  ...extra,
});

describe('import mapping model', () => {
  it('starts from suggestions, dropping new fields for non-builders', () => {
    const columns = [
      column(0, 'Name', { suggestion: { fieldId: 1 } }),
      column(1, 'Region', { suggestion: { create: { name: 'Region', type: 'single_select' } } }),
      column(2, 'Link', { suggestion: { create: { name: 'Link', type: 'relation' } } }),
    ];
    expect(initialDestinations(columns, true)).toEqual([
      { kind: 'field', fieldId: 1 },
      { kind: 'create', name: 'Region', type: 'single_select' },
      { kind: 'skip' },
    ]);
    expect(initialDestinations(columns, false)).toEqual([
      { kind: 'field', fieldId: 1 },
      { kind: 'skip' },
      { kind: 'skip' },
    ]);
  });

  it('turns select values into destinations and destinations into the request', () => {
    const region = column(1, ' Region ', { inferredType: 'number' });
    expect(destinationFromValue('create', region, { kind: 'skip' })).toEqual({
      kind: 'create',
      name: 'Region',
      type: 'number',
    });
    expect(destinationFromValue('field:4', region, { kind: 'skip' })).toEqual({ kind: 'field', fieldId: 4 });
    expect(destinationFromValue('skip', region, { kind: 'field', fieldId: 4 })).toEqual({ kind: 'skip' });
    expect(
      mappingRequest([
        { kind: 'field', fieldId: 1 },
        { kind: 'skip' },
        { kind: 'create', name: ' New ', type: 'text' },
      ]),
    ).toEqual([
      { column: 0, fieldId: 1 },
      { column: 2, create: { name: 'New', type: 'text' } },
    ]);
  });

  it('reports what blocks the dry run', () => {
    const fields = [field(1, 'Name')];
    expect(mappingProblems([{ kind: 'skip' }], fields)).toEqual([{ key: 'nothingMapped' }]);
    expect(
      mappingProblems(
        [
          { kind: 'field', fieldId: 1 },
          { kind: 'field', fieldId: 1 },
          { kind: 'create', name: 'X', type: 'text' },
          { kind: 'create', name: 'x ', type: 'text' },
          { kind: 'create', name: ' ', type: 'text' },
        ],
        fields,
      ),
    ).toEqual([{ key: 'duplicateField', name: 'Name' }, { key: 'duplicateName', name: 'x' }, { key: 'emptyName' }]);
  });

  it('names columns like a spreadsheet and leads samples with the header row when it is data', () => {
    expect([0, 25, 26, 51, 701, 702].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA']);
    const name = column(0, 'Name', { samples: ['1', '2', '3', '4', '5'] });
    expect(columnSamples(name, true)).toEqual(['1', '2', '3', '4', '5']);
    expect(columnSamples(name, false)).toEqual(['Name', '1', '2', '3', '4']);
  });
});
