/** Screen-scoped server data, read whenever the screen is focused; old identities never apply an answer. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useIsFocused } from 'expo-router';
import type { ApiMiss, ApiResult } from '../api/client';
import { captureIdentity } from './identity';
import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';

export function useResource<T>(load: () => Promise<ApiResult<T>>) {
  const focused = useIsFocused();
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
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- invalidate every pending read on cleanup
      generation.current++;
    };
  }, [focused, refresh, station, member]);
  return { data, error, loading, refresh, setData };
}
