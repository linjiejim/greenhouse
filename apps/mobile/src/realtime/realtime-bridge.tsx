/**
 * <RealtimeBridge/> — mounted once in app/_layout.tsx, renders nothing: runs the realtime
 * connection (./index.ts) with the app's state and routes its events into the stores
 * (./sync.ts).
 *
 * - Connected only while it is wanted: signed in (settled auth, a station that speaks this
 *   app's API) AND in the foreground.
 * - Background → closed at once (1000): iOS would suspend it anyway, and it frees the server's
 *   socket. Foreground → a fresh connection, whose `ready` makes the stores catch up.
 * - Another station or account → closed, then reopened against the new base URL and token. A
 *   station switch raises `useAuth.loading` in the same tick as the change
 *   (auth.switchStation), so the socket is closed for the whole switch and reopens only once
 *   bootstrap() has loaded the new station's session (the target itself also refuses a token
 *   that isn't the active station's: ./index.ts).
 */

import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';
import { realtime } from './index';
import { applyEvent } from './sync';

export function RealtimeBridge(): null {
  const signedIn = useAuth((s) => !s.loading && !!s.user && !s.mismatch);
  const userId = useAuth((s) => s.user?.id ?? null);
  const stationId = useStations((s) => s.activeId);
  const identity = `${stationId ?? ''}:${userId ?? ''}`;
  const [foreground, setForeground] = useState(AppState.currentState === 'active');

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => sub.remove();
  }, []);

  useEffect(() => realtime.on(applyEvent), []);

  // The socket: (re)opened for this identity while wanted, closed otherwise.
  const wanted = signedIn && foreground;
  useEffect(() => {
    if (!wanted) {
      realtime.stop();
      return;
    }
    realtime.start();
    return () => realtime.stop();
  }, [wanted, identity]);

  return null;
}
