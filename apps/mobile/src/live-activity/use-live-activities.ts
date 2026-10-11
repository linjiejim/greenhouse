/**
 * `useLiveActivities()` — mounted once in the root layout, renders nothing. Keeps a Bot's
 * background tasks on the lock screen / Dynamic Island in step with the server
 * (./controller.ts): reconciles when the station, the account, this phone's push
 * registration or the switch change, when the app comes to the foreground, and on the Bots
 * realtime events (debounced) — and tells the station the switch whenever the registration
 * changes, so its "done" pushes wake the app.
 */

import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { realtime } from '../realtime';
import { usePush } from '../push/register';
import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';
import { hydrateLiveActivity, reconcile, syncLiveActivityPref, useLiveActivity } from './controller';

const IOS = Platform.OS === 'ios';
/** Realtime pushes come in bursts (a task's start and its report each touch the conversation). */
const SETTLE_MS = 1000;

export function useLiveActivities(): void {
  const loading = useAuth((s) => s.loading);
  const userId = useAuth((s) => s.user?.id ?? null);
  const stationId = useStations((s) => s.activeId);
  const deviceId = usePush((s) => s.device?.id ?? null);
  const hydrated = useLiveActivity((s) => s.hydrated);
  const on = useLiveActivity((s) => s.on);

  useEffect(() => {
    if (IOS) void hydrateLiveActivity();
  }, []);

  useEffect(() => {
    if (!IOS || !hydrated || loading) return;
    void syncLiveActivityPref().finally(() => reconcile());
  }, [hydrated, loading, userId, stationId, deviceId, on]);

  useEffect(() => {
    if (!IOS) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void reconcile();
      }, SETTLE_MS);
    };
    const app = AppState.addEventListener('change', (state) => {
      if (state === 'active') void reconcile();
    });
    const off = realtime.on((event) => {
      if (event.type === 'resync' || event.type === 'bots:conversation') soon();
    });
    return () => {
      if (timer) clearTimeout(timer);
      app.remove();
      off();
    };
  }, []);
}
