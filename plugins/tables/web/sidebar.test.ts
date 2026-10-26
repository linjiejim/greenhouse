import './__tests__/setup.js';
import { describe, expect, it } from 'vitest';
import { selectedTablesRoute } from './sidebar';

describe('selectedTablesRoute', () => {
  it('selects nothing on a non-id page such as the data catalog', () => {
    expect(selectedTablesRoute('catalog')).toEqual({ baseId: null, type: null, resourceId: null });
  });

  it('selects the base and table from an id route', () => {
    expect(selectedTablesRoute('42/table/7')).toEqual({ baseId: '42', type: 'table', resourceId: '7' });
  });

  it('selects nothing on the Tables home', () => {
    expect(selectedTablesRoute('')).toEqual({ baseId: null, type: null, resourceId: null });
  });
});
