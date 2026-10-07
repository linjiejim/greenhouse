/**
 * The app's one realtime connection (`/api/ws`) — the `Realtime` the thread
 * engines and the Bots sync listen to (contract: src/bots/contract.ts; the
 * client and its close-code rules: src/api/ws.ts). Started and stopped only by
 * <RealtimeBridge/> (./realtime-bridge.tsx, mounted once in app/_layout.tsx),
 * which owns the gates (iOS, internal account, `bots` on, foreground).
 *
 * The URL is computed at every (re)connect, so it always carries the active
 * station's current access token — and only ever that station's: the token
 * goes to the origin of the station the token mirror belongs to, and only
 * when that is the active station (null otherwise — the client stops, and
 * the bridge restarts it once the switch has settled).
 */

import { refreshTokens } from '../api/client';
import { getAccessToken, getTokenStationId } from '../api/token-storage';
import { RealtimeClient, realtimeUrl } from '../api/ws';
import { getActiveStation } from '../store/stations';

/** The socket URL for the active station's own token, or null (signed out / mid-switch). */
export function socketUrl(): string | null {
  const station = getActiveStation();
  const token = getAccessToken();
  if (!station || !token || getTokenStationId() !== station.id) return null;
  return realtimeUrl(station.baseUrl, token);
}

export const realtime = new RealtimeClient({
  WebSocketImpl: WebSocket,
  url: socketUrl,
  refreshTokens,
  clock: {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
});
