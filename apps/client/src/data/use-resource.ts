/** Screen-scoped server data, read whenever the screen is focused; old identities never apply an answer. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useIsFocused } from 'expo-router';
import type { ApiMiss, ApiResult } from '../api/client';
import { captureIdentity } from './identity';
import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';

/** `unfocused`: also read while the screen is covered (a browser dialog opened beside an inspector). */
export function useResource<T>(load: () => Promise<ApiResult<T>>, opts?: { unfocused?: boolean }) {
  const focused = useIsFocused() || !!opts?.unfocused;
  const station = useStations((s) => s.activeId);
  const member = useAuth((s) => s.user?.id);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiMiss | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const n = ++generation.current;
    const current = captureIdentity();
    setLoading(true);
    const result = await load();
    if (n !== generation.current || !current()) return;
    if (result.ok) {
      setData(result.data);
      setError(null);
    } else {
      setError(result);
      if (result.status === 403 || result.status === 404) setData(null);
    }
    setLoading(false);
  }, [load]);
  useEffect(() => {
    setData(null);
    setError(null);
  }, [load, station, member]);
  useEffect(() => {
    if (!focused || !member) return;
    void refresh();
  }, [focused, refresh, station, member]);
  // A new reader, station or member drops every pending read; losing focus does not, because on a
  // wide screen the place stays in view behind the sheet that took focus and must still refresh.
  useEffect(
    () => () => {
      generation.current++;
    },
    [refresh, station, member],
  );
  return { data, error, loading, refresh, setData };
}
