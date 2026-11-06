import { describe, expect, it } from 'vitest';
import { parseObjectUrl } from '@greenhouse/types/object-refs';
import { withLinks } from '../tools/links.js';

describe('tables_query links', () => {
  it('links every base, table and record it answers with the station address', () => {
    expect(withLinks({ bases: [{ id: 'bas_1', name: 'CRM' }] })).toEqual({
      bases: [{ id: 'bas_1', name: 'CRM', url: '#/tables/bas_1' }],
    });
    expect(withLinks({ base: { id: 'bas_1' }, tables: [{ id: 'tbl_1' }], members: [] })).toEqual({
      base: { id: 'bas_1', url: '#/tables/bas_1' },
      tables: [{ id: 'tbl_1', url: '#/tables/bas_1/table/tbl_1' }],
      members: [],
    });
    expect(withLinks({ table: { id: 'tbl_1', base_id: 'bas_1' }, fields: [] })).toMatchObject({
      table: { url: '#/tables/bas_1/table/tbl_1' },
    });
    expect(
      withLinks(
        { records: [{ id: 'rec_1', table_id: 'tbl_1' }], next_cursor: null },
        { baseId: 'bas_1', tableId: 'tbl_1' },
      ),
    ).toEqual({
      records: [{ id: 'rec_1', table_id: 'tbl_1', url: '#/tables/bas_1/table/tbl_1?record=rec_1' }],
      next_cursor: null,
    });
  });

  it('leaves out a link it cannot complete', () => {
    expect(withLinks({ record: { id: 'rec_1', table_id: 'tbl_1' } }, { baseId: null })).toEqual({
      record: { id: 'rec_1', table_id: 'tbl_1' },
    });
    expect(withLinks({ error: 'nope' })).toEqual({ error: 'nope' });
    expect(withLinks(null)).toBeNull();
  });

  it('writes addresses the shared parser reads as the same objects', () => {
    const [base, table, record] = [
      'bas_01M6Q8GKSSB48CA6NBM5GCM4BW',
      'tbl_01M6Q8GKWCSV0PP19PDMD5S1PF',
      'rec_01M6Q8H65P3DHGTX3M257TV23G',
    ];
    const linked = withLinks({ records: [{ id: record }] }, { baseId: base, tableId: table }) as {
      records: { url: string }[];
    };
    expect(parseObjectUrl(linked.records[0]!.url)).toEqual({
      type: 'record',
      id: record,
      baseId: base,
      tableId: table,
    });
  });
});
