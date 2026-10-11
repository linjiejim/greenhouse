/**
 * One view's records, paged (`POST /api/tables/tables/:id/records/query`).
 * Restarts when the query changes; refetches the first page when a write on the
 * table bumps `recordsVersion` (a record sheet saved, a lane move) and when the
 * screen regains focus. A response for an older query is dropped. `failed` with
 * records still shown = a transient failure (offline) after a good load.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { queryRecords, type TableRecord } from '../api/tables';
import type { TableQuery } from '../shared/tables';
import { useTables } from './store';

export function useRecords(
  tableId: number,
  query: Omit<TableQuery, 'cursor' | 'limit'> | null,
  { pageSize = 50 }: { pageSize?: number } = {},
) {
  const [records, setRecords] = useState<TableRecord[] | null>(null);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const version = useTables((s) => s.recordsVersion[tableId] ?? 0);
  const seq = useRef(0);
  const key = query ? JSON.stringify(query) : null;
  const keyRef = useRef(key);
  keyRef.current = key;

  const loadFirst = useCallback(async () => {
    if (!keyRef.current) return;
    const mine = ++seq.current;
    const q = JSON.parse(keyRef.current) as TableQuery;
    const result = await queryRecords(tableId, { ...q, limit: pageSize });
    if (mine !== seq.current) return;
    if (result.ok) {
      setRecords(result.value.records);
      setTotal(result.value.total);
      setCursor(result.value.nextCursor);
      setFailed(false);
    } else {
      setRecords((prev) => prev ?? []);
      setFailed(true);
    }
  }, [tableId, pageSize]);

  // a new query: start over (the list shows its loading state)
  useEffect(() => {
    setRecords(null);
    setCursor(null);
    void loadFirst();
  }, [key, loadFirst]);

  // a write on this table (from this screen or a sheet over it): refresh in place
  const firstVersion = useRef(version);
  useEffect(() => {
    if (version === firstVersion.current) return;
    firstVersion.current = version;
    void loadFirst();
  }, [version, loadFirst]);

  // back from another screen: refresh in place (skip the very first focus — the mount loads)
  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focused.current) void loadFirst();
      focused.current = true;
    }, [loadFirst]),
  );

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore || !keyRef.current) return;
    setLoadingMore(true);
    const mine = seq.current;
    const q = JSON.parse(keyRef.current) as TableQuery;
    const result = await queryRecords(tableId, { ...q, cursor, limit: pageSize });
    setLoadingMore(false);
    if (mine !== seq.current || !result.ok) return;
    setRecords((prev) => {
      const seen = new Set((prev ?? []).map((record) => record.id));
      return [...(prev ?? []), ...result.value.records.filter((record) => !seen.has(record.id))];
    });
    setCursor(result.value.nextCursor);
  }, [cursor, loadingMore, tableId, pageSize]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await loadFirst();
    setRefreshing(false);
  }, [loadFirst]);

  /** An optimistic local patch (a lane move) — the next load confirms or rolls it back. */
  const patch = useCallback((recordId: number, next: Partial<TableRecord>) => {
    setRecords((prev) =>
      prev ? prev.map((record) => (record.id === recordId ? { ...record, ...next } : record)) : prev,
    );
  }, []);

  return {
    records,
    total,
    hasMore: !!cursor,
    failed,
    loadMore,
    loadingMore,
    refresh,
    refreshing,
    reload: loadFirst,
    patch,
  };
}
