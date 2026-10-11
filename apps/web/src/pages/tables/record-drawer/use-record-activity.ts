/**
 * A record's activity feed for the drawer: the newest page, older pages on
 * demand, and local updates after the viewer's own comment writes (no
 * refetch for those). `refresh` re-reads the newest page — after the record
 * changed (its revision, or `tables:records_changed` from someone else).
 * Requests that finish after a newer one started are dropped.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  listTableRecordActivity,
  type TableRecordActivityItem,
  type TableRecordActivityPage,
  type TableRecordActivityViewer,
  type TableRecordCommentView,
} from '../../../lib/api/tables';

export type RecordActivityStatus = 'loading' | 'ready' | 'error';

/** One page of a record's activity, newest first (`cursor` = older). Memoize it: a new loader reloads. */
export type RecordActivityLoader = (cursor?: string) => Promise<TableRecordActivityPage>;

const itemKey = (item: Pick<TableRecordActivityItem, 'kind' | 'id'>) => `${item.kind}:${item.id}`;

/** `loader`: where the pages come from — the Tables route by default, an app's gateway for app viewers. */
export function useRecordActivity(tableId: number, recordId: number, loader?: RecordActivityLoader) {
  const tablesLoader = useMemo<RecordActivityLoader>(
    () => (cursor) =>
      cursor === undefined
        ? listTableRecordActivity(tableId, recordId)
        : listTableRecordActivity(tableId, recordId, cursor),
    [tableId, recordId],
  );
  const load = loader ?? tablesLoader;
  const [items, setItems] = useState<TableRecordActivityItem[]>([]);
  const [viewer, setViewer] = useState<TableRecordActivityViewer | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<RecordActivityStatus>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const run = ++generation.current;
    try {
      const page = await load();
      if (run !== generation.current) return;
      setItems(page.items);
      setViewer(page.viewer ?? null);
      setNextCursor(page.nextCursor);
      setStatus('ready');
    } catch {
      // A failed background refresh keeps what is on screen; only a first load shows the error.
      if (run === generation.current) setStatus((current) => (current === 'ready' ? current : 'error'));
    }
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const run = generation.current;
    setLoadingMore(true);
    try {
      const page = await load(nextCursor);
      if (run !== generation.current) return;
      setItems((current) => {
        const seen = new Set(current.map(itemKey));
        return [...current, ...page.items.filter((item) => !seen.has(itemKey(item)))];
      });
      setNextCursor(page.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }, [load, loadingMore, nextCursor]);

  useEffect(() => {
    setStatus('loading');
    setItems([]);
    setNextCursor(null);
    void refresh();
  }, [refresh]);

  const added = useCallback((comment: TableRecordCommentView) => {
    setItems((current) => [comment, ...current.filter((item) => itemKey(item) !== itemKey(comment))]);
  }, []);
  const replaced = useCallback((comment: TableRecordCommentView) => {
    setItems((current) => current.map((item) => (itemKey(item) === itemKey(comment) ? comment : item)));
  }, []);
  const removed = useCallback((commentId: number) => {
    setItems((current) => current.filter((item) => !(item.kind === 'comment' && item.id === commentId)));
  }, []);

  return { items, viewer, nextCursor, status, loadingMore, refresh, loadMore, added, replaced, removed };
}
