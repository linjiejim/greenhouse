/**
 * The record query behind one table view: search, sort and filter, cursor
 * paging, and the loaded page. Changing any query input restarts paging (the
 * server's cursors are bound to the query fingerprint).
 *
 * The container is keyed by table, so a different table always starts from the
 * default query rather than inheriting a sort on the previous table's fields.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TableFilterGroup, TableQuery } from '@greenhouse/types/tables';
import { queryTableRecords, type TableRecord } from '../../lib/api/tables';
import { usePersistedPageSize } from '../../hooks/use-persisted-page-size';
import { useT } from '../../lib/i18n';

export const DEFAULT_RECORD_SORT: TableQuery['sort'] = [{ systemField: 'updated_at', direction: 'desc' }];

export interface RecordQueryInput {
  search: string;
  sort: TableQuery['sort'];
  where: TableFilterGroup | undefined;
}

export function useRecordQuery(tableId: number, onError: (message: string) => void) {
  const t = useT();
  const [records, setRecords] = useState<TableRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQueryState] = useState<RecordQueryInput>({
    search: '',
    sort: DEFAULT_RECORD_SORT,
    where: undefined,
  });
  const [page, setPage] = useState(0);
  const [pageSize, setStoredPageSize] = usePersistedPageSize(`tables.${tableId}`, 20);
  const [loading, setLoading] = useState(true);
  const cursorByPage = useRef(new Map<number, string | undefined>([[0, undefined]]));

  const reload = useCallback(async () => {
    setLoading(true);
    onError('');
    try {
      const request = { where: query.where, search: query.search || undefined, sort: query.sort, limit: pageSize };
      let cursor = cursorByPage.current.get(0);
      let result = await queryTableRecords(tableId, { ...request, cursor });
      cursorByPage.current.set(1, result.nextCursor ?? undefined);
      for (let currentPage = 1; currentPage <= page; currentPage += 1) {
        cursor = cursorByPage.current.get(currentPage);
        if (!cursor) {
          result = { ...result, records: [] };
          break;
        }
        result = await queryTableRecords(tableId, { ...request, cursor });
        cursorByPage.current.set(currentPage + 1, result.nextCursor ?? undefined);
      }
      setRecords(result.records);
      setTotal(result.total);
    } catch (loadError) {
      onError(loadError instanceof Error ? loadError.message : t('tables.loadRecordsFailed'));
    } finally {
      setLoading(false);
    }
  }, [onError, page, pageSize, query, tableId, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const restartPaging = () => {
    cursorByPage.current = new Map([[0, undefined]]);
    setPage(0);
  };

  /** Change part of the query; paging restarts. */
  const setQuery = (patch: Partial<RecordQueryInput>) => {
    restartPaging();
    setQueryState((current) => ({ ...current, ...patch }));
  };

  const setPageSize = (size: number) => {
    restartPaging();
    setStoredPageSize(size);
  };

  return {
    ...query,
    setQuery,
    records,
    setRecords,
    total,
    loading,
    page,
    setPage,
    pageSize,
    setPageSize,
    reload,
  };
}
