/**
 * One Agent's computer status — the web's `useComputerStatus`
 * (apps/web/src/components/bots/computer-phase.tsx) on the phone: one GET, then
 * the realtime `bots:computer` pushes about *this* computer (patched at once,
 * then re-read for what a push does not carry; pushes about the member's other
 * computers are ignored — ./target.ts), and a poll as the safety net — every 2 s
 * while the server is mid-transition, every 20 s otherwise, only while the app is
 * in front.
 *
 * `bot` names the computer (null = the main Agent's, Sprouty's). Switching it
 * starts over — no view of the previous computer lingers — and an answer about
 * the previous one arriving late is dropped. Used by the computer page and, for
 * its 🖥 state, by a thread's bar.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { computerStatus, startComputer } from '../../api/bots';
import { realtime } from '../../realtime';
import type { ComputerStatusView } from '../../shared/bots';
import { computerPhase, isTransientPhase, type ComputerPhase } from '../vendor/computer-phase';
import { computerEventMatches, viewMatches, type ComputerBot } from './target';

const FAST_POLL_MS = 2_000;
const SLOW_POLL_MS = 20_000;

export interface ComputerStatusState {
  /** Whose computer this is (null = the main Agent's). */
  bot: ComputerBot;
  status: ComputerStatusView | null;
  phase: ComputerPhase | null;
  /** The first read failed (nothing to show yet). */
  loadError: boolean;
  /** The server's code for that failure (`agent_not_found`: the Agent is not the member's, or gone). */
  loadErrorCode: string | null;
  /** A start is in flight (it may wait in the queue for a while). */
  starting: boolean;
  refresh: () => Promise<void>;
  /** Replace the view with a fresher one an action returned (ignored when it is another computer's). */
  apply: (next: ComputerStatusView) => void;
  /** Wake it; false when the server refused (the caller explains). */
  start: () => Promise<boolean>;
}

export function useComputerStatus(enabled: boolean, bot: ComputerBot = null): ComputerStatusState {
  const [state, setState] = useState<{ bot: ComputerBot; status: ComputerStatusView | null }>({ bot, status: null });
  const [failure, setFailure] = useState<{ code: string | null } | null>(null);
  const [starting, setStarting] = useState(false);
  const mounted = useRef(true);
  const current = useRef(bot);
  current.current = bot;
  // Another computer: forget the last one's view at once (render-time reset, no flash of it).
  const status = state.bot === bot ? state.status : null;
  if (state.bot !== bot) {
    setState({ bot, status: null });
    setFailure(null);
    setStarting(false);
  }
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Keep a view of `forBot`'s computer, unless the hook moved on to another one meanwhile. */
  const store = useCallback((forBot: ComputerBot, next: ComputerStatusView): boolean => {
    if (!mounted.current || current.current !== forBot || !viewMatches(next, forBot)) return false;
    setState({ bot: forBot, status: next });
    return true;
  }, []);

  const refresh = useCallback(async () => {
    const result = await computerStatus(bot);
    if (!mounted.current || current.current !== bot) return;
    if (result.ok) {
      if (store(bot, result.value)) setFailure(null);
    } else setFailure({ code: result.code }); // keep the last good view; only an empty page turns into an error
  }, [bot, store]);

  const start = useCallback(async () => {
    setStarting(true);
    try {
      const result = await startComputer(bot);
      if (result.ok) store(bot, result.value);
      return result.ok;
    } finally {
      if (mounted.current && current.current === bot) setStarting(false);
      void refresh();
    }
  }, [bot, store, refresh]);

  const apply = useCallback((next: ComputerStatusView) => void store(current.current, next), [store]);

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
      if (!computerEventMatches(event, bot, statusRef.current)) return;
      setState((prev) =>
        prev.bot === bot && prev.status
          ? { bot, status: { ...prev.status, state: event.state, controller: event.controller } }
          : prev,
      );
      void refresh();
    });
  }, [enabled, bot, refresh]);

  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(
      () => {
        if (AppState.currentState === 'active') void refresh();
      },
      transient ? FAST_POLL_MS : SLOW_POLL_MS,
    );
    // Back in front: read at once (the lease may have come back while away).
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refresh();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [enabled, transient, refresh]);

  return {
    bot,
    status,
    phase,
    loadError: failure != null && !status,
    loadErrorCode: failure && !status ? failure.code : null,
    starting,
    refresh,
    apply,
    start,
  };
}
