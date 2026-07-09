/** Unit tests — defineCrud resolution defaults (incl. the cards variant). */

import { describe, it, expect } from 'vitest';
import { defineCrud } from '../client/schema.js';
import type { CrudDataSource } from '../client/data-source.js';

interface Row {
  id: string;
  name: string;
  enabled: boolean;
}

const dataSource: CrudDataSource<Row> = {
  list: async () => ({ items: [], total: 0 }),
};

describe('defineCrud resolution', () => {
  it('defaults variant to "table"', () => {
    const s = defineCrud<Row>({ name: 'Row', dataSource, columns: [{ key: 'name', label: 'Name' }] });
    expect(s.variant).toBe('table');
  });

  it('preserves an explicit cards variant', () => {
    const s = defineCrud<Row>({
      name: 'Row',
      dataSource,
      variant: 'cards',
      columns: [{ key: 'name', label: 'Name' }],
      slots: { renderCard: () => null },
    });
    expect(s.variant).toBe('cards');
  });

  it('accepts a toggle column with an onToggle handler', () => {
    const calls: Array<[Row, boolean]> = [];
    const s = defineCrud<Row>({
      name: 'Row',
      dataSource,
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'enabled', label: 'On', type: 'toggle', onToggle: (row, next) => void calls.push([row, next]) },
      ],
    });
    const toggleCol = s.columns.find((c) => c.type === 'toggle');
    expect(toggleCol).toBeDefined();
    // The handler is callable and typed against the row.
    if (toggleCol && toggleCol.type === 'toggle') {
      toggleCol.onToggle({ id: '1', name: 'a', enabled: false }, true, {
        reload: () => {},
        openCreate: () => {},
        openEdit: () => {},
        openDetail: () => {},
        openDelete: () => {},
      });
    }
    expect(calls).toEqual([[{ id: '1', name: 'a', enabled: false }, true]]);
  });
});
