/**
 * `useUserName()` — resolves a user id (a doc's `updated_by`, a version's
 * `changed_by`) to a display name for author labels. The signed-in user is
 * always known; everyone else comes from a best-effort directory (see
 * `listUserNames`), fetched once per station + signed-in user. The cache is
 * dropped whenever the signed-in user or the active station changes (same
 * subscriptions as src/store/tags.ts), and every answer is tagged with the
 * station + user it was fetched for, so a switch never shows the previous
 * server's names — not even from a request still in flight. Unknown ids
 * resolve to `undefined` so callers just omit the author instead of showing a
 * raw id.
 */

import { useEffect, useState } from 'react';
import { listUserNames } from '../api/knowledge';
import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';

const directories = new Map<string, Promise<Map<string, string>>>();

// Per account per station — drop the cache when either changes (sign-out,
// another account, station switch); the next mount refetches.
useAuth.subscribe((s, prev) => {
  if ((s.user?.id ?? null) !== (prev.user?.id ?? null)) directories.clear();
});
useStations.subscribe((s, prev) => {
  if (s.activeId !== prev.activeId) directories.clear();
});

function loadDirectory(key: string): Promise<Map<string, string>> {
  let entry = directories.get(key);
  if (!entry) {
    entry = listUserNames().then((m) => {
      // An empty result is usually a failed/forbidden request — allow a retry next mount.
      if (m.size === 0) directories.delete(key);
      return m;
    });
    directories.set(key, entry);
  }
  return entry;
}

export function useUserName(): (id?: string | null) => string | undefined {
  const me = useAuth((s) => s.user);
  const stationId = useStations((s) => s.activeId);
  const signedIn = !!me;
  const key = `${stationId ?? ''}:${me?.id ?? ''}`;
  const [names, setNames] = useState<{ key: string; map: Map<string, string> } | null>(null);

  useEffect(() => {
    if (!signedIn) return;
    let alive = true;
    void loadDirectory(key).then((map) => {
      if (alive) setNames({ key, map });
    });
    return () => {
      alive = false;
    };
  }, [key, signedIn]);

  return (id) => {
    if (!id) return undefined;
    if (me && id === me.id) return me.nickname;
    return names?.key === key ? names.map.get(id) : undefined;
  };
}
