/**
 * <RealtimeBridge/> — mounted once in app/_layout.tsx, renders nothing: runs
 * the realtime connection (./index.ts) with the app's state and routes its
 * pushes into the Bots store (spec docs/specs/20261008-mobile-bots.md §2.7.2).
 *
 * - Connected only while it is wanted: signed in on an internal account with
 *   Bots available (`useBotsEnabled`: iOS, settled auth, `super`/`team`,
 *   `features.bots`, not refused by the server) AND in the foreground. An
 *   external account never connects (the server would answer 4001 forever).
 * - Background → closed at once (1000): iOS would suspend it anyway, and it
 *   frees the server's per-user socket slots. Foreground → a fresh connection,
 *   whose `connected` frame makes every listener resync.
 * - Another station or account → closed, then reopened against the new base
 *   URL and token. A station switch raises `useAuth.loading` in the same tick
 *   as the change (auth.switchStation), which closes `useBotsEnabled` — so the
 *   socket is closed for the whole switch and reopens only once bootstrap()
 *   has loaded the new station's session (the URL itself also refuses a token
 *   that isn't the active station's: ./index.ts).
 * - The Bots sync (src/bots/sync.ts) lives while Bots are available — in the
 *   background too, idle — and is told about the foreground for its polling
 *   fallback.
 */

import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { getConversation } from '../api/bots';
import { useBotsEnabled } from '../bots/availability';
import { useBots } from '../bots/store';
import { startBotsSync, type BotsSync } from '../bots/sync';
import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';
import { realtime } from './index';

const clock = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function RealtimeBridge(): null {
  const enabled = useBotsEnabled();
  const userId = useAuth((s) => s.user?.id ?? null);
  const stationId = useStations((s) => s.activeId);
  const identity = `${stationId ?? ''}:${userId ?? ''}`;
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const sync = useRef<BotsSync | null>(null);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => sub.remove();
  }, []);

  // The socket: (re)opened for this identity while wanted, closed otherwise.
  const wanted = enabled && foreground;
  useEffect(() => {
    if (!wanted) {
      realtime.stop();
      return;
    }
    realtime.start();
    return () => realtime.stop();
  }, [wanted, identity]);

  // The store side, per identity while Bots are available.
  useEffect(() => {
    if (!enabled) return;
    const started = startBotsSync({
      realtime,
      store: { getState: useBots.getState, subscribe: (listener) => useBots.subscribe(listener) },
      api: { getConversation },
      clock,
    });
    sync.current = started;
    return () => {
      started.dispose();
      if (sync.current === started) sync.current = null;
    };
  }, [enabled, identity]);

  useEffect(() => {
    sync.current?.setForeground(foreground);
  }, [foreground, enabled, identity]);

  return null;
}
