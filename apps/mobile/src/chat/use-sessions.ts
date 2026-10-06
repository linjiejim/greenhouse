/**
 * `useSessions` — paginated conversation-history loader for the drawer.
 *
 * Server contract (`GET /api/sessions?page_meta=1`, src/api/sessions.ts): pages
 * continue from `next_offset` while `has_more`; the tag filter is applied per
 * page *after* paging, so a filtered page can be short or empty while more
 * exist; there is no server-side title search (the web filters loaded rows
 * too). So:
 *  - the tag filter goes to the server and hard-resets pagination on change
 *    (an in-flight page for a stale filter is discarded);
 *  - the title search filters the loaded rows client-side (instant, no
 *    request per keystroke);
 *  - while the *visible* list is short (thin tag pages, few search matches)
 *    and more pages exist, it keeps paging on its own — capped for searches
 *    so a sparse match doesn't page through a huge history unprompted;
 *  - `refresh()` re-fetches the first page in place (no blank flash) — the
 *    drawer calls it each time it opens so new / renamed / deleted
 *    conversations show up;
 *  - a failed page sets `error` (and does NOT mark the list done), so the
 *    drawer can tell "couldn't load" from "no conversations" and offer a retry.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchSessionsPage } from '../api/sessions';
import type { Session } from '../shared/greenhouse-types';

/** Keep paging on our own until at least this many rows are visible. */
const MIN_VISIBLE = 15;
/** …but a search stops auto-paging after scanning this many conversations. */
const SEARCH_SCAN_CAP = 600;

export function useSessions(enabled: boolean, pageSize = 30, tagId: number | null = null, search = '') {
  const [all, setAll] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(false);
  const nextOffset = useRef(0);
  const busy = useRef(false);
  const doneRef = useRef(false);
  const tagRef = useRef<number | null>(tagId);

  const loadMore = useCallback(async () => {
    if (busy.current || doneRef.current) return;
    busy.current = true;
    setLoading(true);
    setError(false);
    const forTag = tagRef.current;
    const page = await fetchSessionsPage({ limit: pageSize, offset: nextOffset.current, tagId: forTag });
    // The tag filter changed while this page was in flight — discard it (the
    // reset already started the new filter's first page).
    if (tagRef.current !== forTag) return;
    busy.current = false;
    setLoading(false);
    if (!page) {
      setError(true);
      return;
    }
    setAll((prev) => {
      const seen = new Set(prev.map((p) => p.id));
      return [...prev, ...page.sessions.filter((b) => !seen.has(b.id))];
    });
    nextOffset.current = page.nextOffset;
    if (!page.hasMore) {
      doneRef.current = true;
      setDone(true);
    }
  }, [pageSize]);

  // Kick off the first page once the surface becomes visible.
  useEffect(() => {
    if (enabled && all.length === 0 && !doneRef.current && !busy.current) void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Tag filter change → hard reset + reload (skips the initial mount).
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    tagRef.current = tagId;
    nextOffset.current = 0;
    doneRef.current = false;
    busy.current = false;
    setDone(false);
    setError(false);
    setAll([]);
    if (enabled) void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagId]);

  /** Re-fetch the first page and swap it in (keeps the list on screen meanwhile). */
  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const forTag = tagRef.current;
    const empty = nextOffset.current === 0;
    if (empty) setLoading(true);
    const page = await fetchSessionsPage({ limit: pageSize, offset: 0, tagId: forTag });
    if (tagRef.current !== forTag) return;
    busy.current = false;
    if (empty) setLoading(false);
    if (!page) {
      // Keep what's on screen; only an empty list needs to say it failed.
      setError(true);
      return;
    }
    setError(false);
    setAll(page.sessions);
    nextOffset.current = page.nextOffset;
    doneRef.current = !page.hasMore;
    setDone(doneRef.current);
  }, [pageSize]);

  const query = search.trim().toLowerCase();
  const items = useMemo(
    () => (query ? all.filter((s) => (s.title || '').toLowerCase().includes(query)) : all),
    [all, query],
  );

  // Thin visible list (tag filter, search) with more pages behind it → keep paging.
  useEffect(() => {
    if (!enabled || loading || done || error || all.length === 0) return;
    if (items.length >= MIN_VISIBLE || (query && all.length >= SEARCH_SCAN_CAP)) return;
    void loadMore();
  }, [enabled, loading, done, error, all.length, items.length, query, loadMore]);

  const removeItem = useCallback((id: string) => setAll((it) => it.filter((x) => x.id !== id)), []);

  return { items, loading, done, error, loadMore, refresh, removeItem };
}
