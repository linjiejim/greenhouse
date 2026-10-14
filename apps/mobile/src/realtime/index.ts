/**
 * The app's one realtime connection (`/api/ws`, ../api/realtime.ts). Started and stopped only
 * by <RealtimeBridge/> (./realtime-bridge.tsx, mounted once in app/_layout.tsx), which owns the
 * gates (signed in, foreground).
 *
 * The target is computed at every (re)connect, so the hello always carries the active
 * station's current access token — and only ever that station's: the token goes to the origin
 * of the station the token mirror belongs to, and only when that is the active station (null
 * otherwise — the client stops, and the bridge restarts it once the switch has settled).
 */

import { refreshTokens } from '../api/client';
import { RealtimeClient, realtimeUrl } from '../api/realtime';
import { getAccessToken, getTokenStationId } from '../api/token-storage';
import { getActiveStation } from '../store/stations';

/** The socket URL and the token for the active station's own session, or null (signed out / mid-switch). */
export function socketTarget(): { url: string; token: string } | null {
  const station = getActiveStation();
  const token = getAccessToken();
  if (!station || !token || getTokenStationId() !== station.id) return null;
  return { url: realtimeUrl(station.baseUrl), token };
}

export const realtime = new RealtimeClient({
  WebSocketImpl: WebSocket,
  target: socketTarget,
  refreshTokens,
  clock: {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
});
