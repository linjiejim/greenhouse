/**
 * The app's one realtime connection (`/api/ws`) — the `Realtime` the thread
 * engines and the Bots sync listen to (contract: src/bots/contract.ts; the
 * client and its close-code rules: src/api/ws.ts). Started and stopped only by
 * <RealtimeBridge/> (./realtime-bridge.tsx, mounted once in app/_layout.tsx),
 * which owns the gates (iOS, internal account, `bots` on, foreground).
 *
 * The URL is computed at every (re)connect, so it always carries the active
 * station's current access token.
 */

import { refreshTokens } from '../api/client';
import { getAccessToken } from '../api/token-storage';
import { RealtimeClient, realtimeUrl } from '../api/ws';
import { getApiBase } from '../store/stations';

export const realtime = new RealtimeClient({
  WebSocketImpl: WebSocket,
  url: () => {
    const token = getAccessToken();
    return token ? realtimeUrl(getApiBase(), token) : null;
  },
  refreshTokens,
  clock: {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
});
