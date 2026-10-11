/**
 * The record query behind one table view: search, sort and filter, cursor
 * paging, and the loaded page. Changing any query input restarts paging (the
 * server's cursors are bound to the query fingerprint).
 *
 * The view's type adds a `shape` (`./views/view-query.ts`): the grid's
 * grouping, a calendar's visible window, or a fixed limit with no paging
 * (kanban, calendar). A new shape restarts paging too.
 *
 * The container is keyed by table, so a different table always starts from the
 * default query rather than inheriting a sort on the previous table's fields.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TableFilterGroup, TableGroupBy, TableQuery } from '@greenhouse/types/tables';
import { queryTableRecords, type TableRecord } from '../../lib/api/tables';
import { usePersistedPageSize } from '../../hooks/use-persisted-page-size';
import { useT } from '../../lib/i18n';
import { viewerTimeZone } from './views/view-query';

export const DEFAULT_RECORD_SORT: TableQuery['sort'] = [{ systemField: 'updated_at', direction: 'desc' }];

export interface RecordQueryInput {
  search: string;
  sort: TableQuery['sort'];
  where: TableFilterGroup | undefined;
}

/** The query parts a view type adds on top of search / sort / filter. */
export interface RecordQueryShape {
  groupBy?: TableGroupBy;
  filters?: TableFilterGroup[];
  /** Load one page of at most this many records and turn paging off. */
  limit?: number;
}

const NO_SHAPE: RecordQueryShape = {};

export function useRecordQuery(
  tableId: number,
  onError: (message: string) => void,
  shape: RecordQueryShape = NO_SHAPE,
) {
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
  // The shape arrives as a fresh object every render; its JSON is the identity.
  const shapeKey = JSON.stringify(shape);
  const appliedShape = useRef(shapeKey);
  /** Only the latest request may land: a slow page must not overwrite a newer one. */
  const latestRequest = useRef(0);

  const reload = useCallback(async () => {
    const current = JSON.parse(shapeKey) as RecordQueryShape;
    if (appliedShape.current !== shapeKey) {
      appliedShape.current = shapeKey;
      cursorByPage.current = new Map([[0, undefined]]);
      if (page !== 0) {
        setPage(0);
        return;
      }
    }
    const requestId = ++latestRequest.current;
    const lastPage = current.limit ? 0 : page;
    setLoading(true);
    onError('');
    try {
      const request: TableQuery = {
        where: query.where,
        search: query.search || undefined,
        sort: query.sort,
        limit: current.limit ?? pageSize,
        ...(current.groupBy ? { groupBy: current.groupBy } : {}),
        ...(current.filters?.length ? { filters: current.filters } : {}),
      };
      // Same zone as the view's group counts, so `$today` and day filters agree with them.
      const timezone = viewerTimeZone();
      let cursor = cursorByPage.current.get(0);
      let result = await queryTableRecords(tableId, { ...request, cursor }, timezone);
      cursorByPage.current.set(1, result.nextCursor ?? undefined);
      for (let currentPage = 1; currentPage <= lastPage; currentPage += 1) {
        cursor = cursorByPage.current.get(currentPage);
        if (!cursor) {
          result = { ...result, records: [] };
          break;
        }
        result = await queryTableRecords(tableId, { ...request, cursor }, timezone);
        cursorByPage.current.set(currentPage + 1, result.nextCursor ?? undefined);
      }
      if (requestId !== latestRequest.current) return;
      setRecords(result.records);
      setTotal(result.total);
    } catch (loadError) {
      if (requestId !== latestRequest.current) return;
      onError(loadError instanceof Error ? loadError.message : t('tables.loadRecordsFailed'));
    } finally {
      if (requestId === latestRequest.current) setLoading(false);
    }
  }, [onError, page, pageSize, query, shapeKey, tableId, t]);

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
    /** False when the shape loads one fixed page (kanban, calendar). */
    paged: !shape.limit,
    reload,
  };
}
