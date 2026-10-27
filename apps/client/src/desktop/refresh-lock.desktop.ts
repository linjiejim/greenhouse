import { getAccessToken, getRefreshToken, getTokenStationId, hydrateTokens } from '../api/token-storage';
import { flushCredentials } from '../api/persistence.desktop';
/** WKWebView windows share rotating sessions. Web Locks serialize the one-use refresh token. */
export async function withRefreshLock(station: string | null, refresh: () => Promise<boolean>): Promise<boolean> {
  if (!navigator.locks) throw new Error('This macOS WebKit version does not support session locking');
  const expected = getRefreshToken();
  return navigator.locks.request(`greenhouse-session:${station}`, async () => {
    if (getTokenStationId() !== station) return false;
    await hydrateTokens(station);
    if (getTokenStationId() !== station) return false;
    if (getRefreshToken() !== expected && getAccessToken()) return true;
    const result = await refresh();
    await flushCredentials();
    return result;
  });
}
