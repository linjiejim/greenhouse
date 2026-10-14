import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { RecordDetail, TableRecord } from '@greenhouse/contract';
import { applyTablesEvent, putRecords, tablesKeys, type ViewRecords } from '../tables';

const clients: QueryClient[] = [];
const client = () => {
  const value = new QueryClient();
  clients.push(value);
  return value;
};
const row = (revision: number, computed_revision: number, value: string) =>
  ({
    created_by: null,
    updated_by: null,
    created_at: '2026-10-15T00:00:00Z',
    updated_at: '2026-10-15T00:00:00Z',
    id: 'rec_1',
    table_id: 'tbl_1',
    revision,
    computed_revision,
    values: { fld_1: value },
  }) as TableRecord;
const page = (record: TableRecord): ViewRecords => ({ items: [record], linked: {}, files: {}, truncated: false });
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  clients.forEach((item) => item.clear());
  clients.length = 0;
});

it('refreshes both the view and drawer on a computed revision without a record edit', () => {
  vi.useFakeTimers();
  const cache = client();
  const key = tablesKeys.view('tbl_1', {});
  cache.setQueryData(key, page(row(2, 3, 'before')));
  cache.setQueryData(tablesKeys.record('rec_1'), { record: row(2, 3, 'before') } as RecordDetail);
  applyTablesEvent(cache, {
    type: 'records.changed',
    data: { base_id: 'bas_1', table_id: 'tbl_1', records: [{ id: 'rec_1', revision: 2, computed_revision: 4 }] },
  });
  vi.advanceTimersByTime(400);
  expect(cache.getQueryState(key)?.isInvalidated).toBe(true);
  expect(cache.getQueryState(tablesKeys.record('rec_1'))?.isInvalidated).toBe(true);
  putRecords('tbl_1', [row(2, 4, 'after')], {}, cache);
  putRecords('tbl_1', [row(2, 3, 'late old answer')], {}, cache);
  expect(cache.getQueryData<ViewRecords>(key)?.items[0]?.values.fld_1).toBe('after');
  expect(cache.getQueryData<RecordDetail>(tablesKeys.record('rec_1'))?.record.values.fld_1).toBe('after');
});

it('discards cached values and search hits when access rules change', () => {
  vi.useFakeTimers();
  const cache = client();
  const key = tablesKeys.view('tbl_1', {});
  cache.setQueryData(key, page(row(2, 3, 'secret')));
  cache.setQueryData(tablesKeys.record('rec_1'), { record: row(2, 3, 'secret') });
  cache.setQueryData(['search', 'secret'], { items: ['secret'] });
  applyTablesEvent(cache, { type: 'base.updated', data: { base_id: 'bas_1' } });
  expect(cache.getQueryData(key)).toBeUndefined();
  expect(cache.getQueryData(tablesKeys.record('rec_1'))).toBeUndefined();
  expect(cache.getQueryData(['search', 'secret'])).toBeUndefined();
});
