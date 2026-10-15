/**
 * My computer of one Agent (AGNT-18, AGNT-20): its state (stopped, starting, running, failed),
 * start / stop / restart, kept current by the realtime `computer.updated` event and a gentle poll
 * while it is starting.
 */

import { useCallback, useEffect, useState } from 'react';
import { getComputer, restartComputer, startComputer, stopComputer } from '../api/computer';
import { realtime } from '../realtime';
import type { ComputerView } from '../shared/contract';

export function useComputer(agentId: string) {
  const [computer, setComputer] = useState<ComputerView | null>(null);
  const [failed, setFailed] = useState<{ code: string; message: string } | null>(null);
  const [busy, setBusy] = useState<'start' | 'stop' | 'restart' | null>(null);

  const refresh = useCallback(async () => {
    const result = await getComputer(agentId);
    if (result.ok) {
      setComputer(result.data);
      setFailed(null);
    } else setFailed({ code: result.code, message: result.message });
  }, [agentId]);

  useEffect(() => {
    void refresh();
    return realtime.on((event) => {
      if (event.type === 'computer.updated' && event.data.agent_id === agentId) void refresh();
      if (event.type === 'resync') void refresh();
    });
  }, [agentId, refresh]);

  // Starting takes a while: look again until it settles.
  const starting = computer?.state === 'starting' || computer?.state === 'queued';
  useEffect(() => {
    if (!starting) return undefined;
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [starting, refresh]);

  const act = useCallback(
    async (action: 'start' | 'stop' | 'restart') => {
      setBusy(action);
      const call = action === 'start' ? startComputer : action === 'stop' ? stopComputer : restartComputer;
      const result = await call(agentId);
      setBusy(null);
      if (result.ok) setComputer(result.data);
      return result;
    },
    [agentId],
  );

  return { computer, failed, busy, refresh, act };
}
