import { describe, expect, it, vi } from 'vitest';
import type { CatalogInput } from './catalog.js';
const fixture = vi.hoisted(() => ({
  sources: [] as Array<{ id: string; load: (input: unknown) => Promise<unknown> }>,
}));
vi.mock('../plugin-host/index.js', () => ({
  EXTENSIONS: [],
  fromExtensions: (field: string) => (field === 'catalogSources' ? fixture.sources : []),
}));
import { buildDataCatalog } from './catalog.js';
describe('catalog plugin sources', () => {
  it('merges the active fixture contribution and leaves no rows when absent', async () => {
    const input = { db: {}, actor: {}, reachable: new Set(['fixture_query']) } as unknown as CatalogInput;
    const base = { id: 'fixture', kind: 'tables_base', tables: [] };
    fixture.sources.push({
      id: 'fixture',
      load: async (caller) => {
        expect(caller).toBe(input);
        return { bases: [base], truncated: true };
      },
    });
    expect(await buildDataCatalog(input)).toMatchObject({ bases: [base], truncated: true });
    fixture.sources.length = 0;
    expect(await buildDataCatalog(input)).toMatchObject({ bases: [], truncated: false });
  });
});
