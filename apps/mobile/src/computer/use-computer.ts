/**
 * My computer of one Agent (AGNT-18, AGNT-20): its state (queued, stopped, starting, running, failed),
 * start / stop / restart, kept current by the realtime `computer.updated` event and a gentle poll
 * while it is starting.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useIsFocused } from 'expo-router';
import { getComputer, restartComputer, startComputer, stopComputer } from '../api/computer';
import { useResource } from '../data/use-resource';

export function useComputer(agentId: string) {
  const focused = useIsFocused();
  const pending = useRef(false);
  const resource = useResource(
    useCallback(() => getComputer(agentId), [agentId]),
    ['computer.updated'],
  );
  const computer = resource.data;
  const failed = resource.error;
  const refresh = resource.refresh;
  const [busy, setBusy] = useState<'start' | 'stop' | 'restart' | null>(null);

  const starting = computer?.state === 'starting' || computer?.state === 'queued';
  useEffect(() => {
    if (!starting || !focused) return;
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [starting, focused, refresh]);

  const act = useCallback(
    async (action: 'start' | 'stop' | 'restart') => {
      if (pending.current) return null;
      pending.current = true;
      const current = resource.captureWrite();
      setBusy(action);
      const call = action === 'start' ? startComputer : action === 'stop' ? stopComputer : restartComputer;
      const result = await call(agentId);
      pending.current = false;
      setBusy(null);
      if (!current()) return null;
      if (result.ok) resource.setData(result.data);
      return result;
    },
    [agentId, resource],
  );

  return { computer, failed, busy, refresh, act };
}
