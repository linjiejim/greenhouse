/**
 * `useResource` with an offline copy (../data/offline-view.ts): the copy saved for `kind` shows
 * at once, the station's answer replaces it and is saved, an unreachable station keeps the copy
 * marked offline, and a 403 / 404 deletes it. Copies belong to the station + member that saved
 * them (../store/offline.ts) and are read again when either changes.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ApiResult } from '../api/client';
import { readOffline, removeOffline, writeOffline } from '../store/offline';
import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';
import { captureIdentity } from './identity';
import { offlineView } from './offline-view';
import { useResource } from './use-resource';

export function useOfflineResource<T>(
  kind: string | null,
  load: () => Promise<ApiResult<T>>,
  parse: (saved: unknown) => T | null,
) {
  const resource = useResource(load);
  const station = useStations((s) => s.activeId);
  const member = useAuth((s) => s.user?.id);
  const [saved, setSaved] = useState<{ kind: string; data: T } | null>(null);

  useEffect(() => {
    setSaved(null);
    if (!kind) return;
    let alive = true;
    const current = captureIdentity();
    void readOffline(kind).then((value) => {
      const data = parse(value);
      if (alive && current() && data !== null) setSaved({ kind, data });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- parse is a pure reader
  }, [kind, station, member]);

  // the station's answer is the new copy
  useEffect(() => {
    if (kind && resource.data !== null) writeOffline(kind, resource.data);
  }, [kind, resource.data]);

  const mine = saved && saved.kind === kind ? saved.data : null;
  const view = useMemo(
    () =>
      offlineView({
        fresh: resource.data,
        saved: mine,
        loading: resource.loading,
        missStatus: resource.error ? resource.error.status : null,
      }),
    [resource.data, mine, resource.loading, resource.error],
  );

  useEffect(() => {
    if (view.evict && kind) {
      removeOffline(kind);
      setSaved(null);
    }
  }, [view.evict, kind]);

  return { ...resource, data: view.data, offline: view.offline };
}
