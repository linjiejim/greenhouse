/** Screen-scoped server data. Reconnects catch up; old identities never apply an answer. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useIsFocused } from 'expo-router';
import type { ApiMiss, ApiResult } from '../api/client';
import { realtime } from '../realtime';
import { captureIdentity } from './identity';
import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';

export function useResource<T>(load: () => Promise<ApiResult<T>>, events: readonly string[] = []) {
  const focused = useIsFocused();
  const station = useStations((s) => s.activeId);
  const member = useAuth((s) => s.user?.id);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiMiss | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const context = useRef({ focused, load });
  context.current = { focused, load };
  useEffect(
    () => () => {
      context.current.focused = false;
    },
    [],
  );
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
    return result;
  }, [load]);
  const eventKey = events.join('|');
  useEffect(() => {
    setData(null);
    setError(null);
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- invalidate every pending read on cleanup
      generation.current++;
    };
  }, [load, station, member]);
  useEffect(() => {
    if (!focused || !member) return;
    void refresh();
    const unsubscribe = realtime.on((event) => {
      if (event.type === 'resync' || eventKey.split('|').includes(event.type)) void refresh();
    });
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- invalidate every pending read on cleanup
      generation.current++;
      unsubscribe();
    };
  }, [focused, refresh, eventKey, station, member]);
  const capture = () => {
    const n = generation.current;
    return () =>
      n === generation.current && useAuth.getState().user?.id === member && useStations.getState().activeId === station;
  };
  const captureWrite = () => {
    const current = captureIdentity();
    return () => current() && context.current.focused && context.current.load === load;
  };
  return { data, error, loading, refresh, setData, capture, captureWrite };
}
