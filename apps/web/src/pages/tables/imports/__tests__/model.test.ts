import { describe, expect, it } from 'vitest';
import type { BaseImport, Field } from '@greenhouse/contract';
import { importTargets, liveMapping, mapColumn, missingRequired, rowsWith, shownColumns } from '../model';

const field = (id: string, type: Field['type'], required = false): Field => ({
  id,
  table_id: 'tbl',
  name: id.toUpperCase(),
  type,
  config: {},
  required,
  is_primary: id === 'title',
  position: 0,
});

const fields = [
  field('title', 'text'),
  field('count', 'number', true),
  field('files', 'attachment'),
  field('total', 'formula'),
  field('due', 'date'),
];

const item = {
  header: true,
  total_rows: 4,
  columns: [
    { index: 0, first: 'Name', samples: ['Apple', 'Pear', 'Plum'] },
    { index: 1, first: '', samples: ['3'] },
  ],
} satisfies Pick<BaseImport, 'header' | 'total_rows' | 'columns'>;

describe('the import model', () => {
  it('offers the fields a column can go into', () => {
    expect(importTargets(fields).map((entry) => entry.id)).toEqual(['title', 'count', 'due']);
  });

  it('reads the columns with or without a header', () => {
    expect(shownColumns(item, true)).toEqual([
      { index: 0, name: 'Name', samples: ['Apple', 'Pear', 'Plum'] },
      { index: 1, name: null, samples: ['3'] },
    ]);
    expect(shownColumns(item, false)).toEqual([
      { index: 0, name: null, samples: ['Name', 'Apple', 'Pear'] },
      { index: 1, name: null, samples: ['3'] },
    ]);
  });

  it('counts the first row in when it is not the header', () => {
    expect(rowsWith(item, true)).toBe(4);
    expect(rowsWith(item, false)).toBe(5);
    expect(rowsWith({ header: false, total_rows: 1 }, true)).toBe(0);
  });

  it('moves a field to the column it is chosen for', () => {
    expect(mapColumn(['title', null, 'due'], 1, 'title')).toEqual([null, 'title', 'due']);
    expect(mapColumn(['title', null, 'due'], 2, null)).toEqual(['title', null, null]);
  });

  it('forgets fields a column can no longer go into, and names required fields left out', () => {
    const targets = importTargets(fields);
    expect(liveMapping(['title', 'gone', 'files'], targets)).toEqual(['title', null, null]);
    expect(missingRequired(fields, ['title', null]).map((entry) => entry.id)).toEqual(['count']);
    expect(missingRequired(fields, ['title', 'count'])).toEqual([]);
  });
});
