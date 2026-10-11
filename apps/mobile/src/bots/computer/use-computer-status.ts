/**
 * The member's computer status while the computer page is open — the web's
 * `useComputerStatus` (apps/web/src/components/bots/computer-phase.tsx) on the
 * phone: one GET, then the realtime `bots:computer` pushes (patched at once,
 * then re-read for what a push does not carry), and a poll as the safety net —
 * every 2 s while the server is mid-transition, every 20 s otherwise, only while
 * the app is in front.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { computerStatus, startComputer } from '../../api/bots';
import { realtime } from '../../realtime';
import type { ComputerStatusView } from '../../shared/bots';
import { computerPhase, isTransientPhase, type ComputerPhase } from '../vendor/computer-phase';

const FAST_POLL_MS = 2_000;
const SLOW_POLL_MS = 20_000;

export interface ComputerStatusState {
  status: ComputerStatusView | null;
  phase: ComputerPhase | null;
  /** The first read failed (nothing to show yet). */
  loadError: boolean;
  /** A start is in flight (it may wait in the queue for a while). */
  starting: boolean;
  refresh: () => Promise<void>;
  /** Replace the view with a fresher one an action returned. */
  apply: (next: ComputerStatusView) => void;
  /** Wake it; false when the server refused (the caller explains). */
  start: () => Promise<boolean>;
}

export function useComputerStatus(enabled: boolean): ComputerStatusState {
  const [status, setStatus] = useState<ComputerStatusView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [starting, setStarting] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const result = await computerStatus();
    if (!mounted.current) return;
    if (result.ok) {
      setStatus(result.value);
      setLoadError(false);
    } else setLoadError(true); // keep the last good view; only an empty page turns into an error
  }, []);

  const start = useCallback(async () => {
    setStarting(true);
    try {
      const result = await startComputer();
      if (mounted.current && result.ok) setStatus(result.value);
      return result.ok;
    } finally {
      if (mounted.current) setStarting(false);
      void refresh();
    }
  }, [refresh]);

  const phase = status ? computerPhase(status, { starting }) : null;
  const transient = starting || (phase ? isTransientPhase(phase) : false);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return undefined;
    return realtime.on((event) => {
      if (event.type === 'resync') void refresh();
      if (event.type !== 'bots:computer') return;
      setStatus((prev) => (prev ? { ...prev, state: event.state, controller: event.controller } : prev));
      void refresh();
    });
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(
      () => {
        if (AppState.currentState === 'active') void refresh();
      },
      transient ? FAST_POLL_MS : SLOW_POLL_MS,
    );
    // Back in front: read at once (the lease may have come back while away).
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [enabled, transient, refresh]);

  return { status, phase, loadError: loadError && !status, starting, refresh, apply: setStatus, start };
}
