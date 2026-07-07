/**
 * Background service worker.
 *
 * Owns the refresh-token rotation: pages send {type: 'auth:refresh', stationId}
 * instead of refreshing themselves, so a single in-flight refresh per station
 * serves all contexts (rotation revokes the old token — two racing refreshes
 * would log the user out). Refreshes are keyed by station id and written back
 * onto that id, so switching the active station mid-refresh can't cross-
 * pollinate tokens. On an invalid/expired refresh token only that station's
 * session is cleared (the registry entry stays), which every page observes via
 * storage.onChanged and falls back to the sign-in flow.
 */

import { getStations, updateStationAuth, type StationAuth } from '../lib/storage';

// Clicking the toolbar icon opens the side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
  // Older Chrome without sidePanel behavior API — user can still open it via the panel picker.
});

// ─── Single-flight token refresh (per station) ───────────

const inflight = new Map<string, Promise<{ ok: boolean; accessToken?: string }>>();

async function refreshTokens(stationId: string): Promise<{ ok: boolean; accessToken?: string }> {
  const { stations } = await getStations();
  const station = stations.find((s) => s.id === stationId);
  if (!station?.auth) return { ok: false };

  let res: Response;
  try {
    res = await fetch(`${station.baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: station.auth.refreshToken }),
    });
  } catch {
    // Network error — keep the stored pair, the next call may succeed.
    return { ok: false };
  }

  if (res.status === 401) {
    // Rotation dead (revoked/expired) — force re-login on this station only.
    await updateStationAuth(stationId, null);
    return { ok: false };
  }
  if (!res.ok) return { ok: false };

  const body = (await res.json().catch(() => null)) as {
    accessToken?: string;
    refreshToken?: string;
    user?: StationAuth['user'];
  } | null;
  if (!body?.accessToken || !body.refreshToken || !body.user) return { ok: false };

  await updateStationAuth(stationId, {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    user: body.user,
  });
  return { ok: true, accessToken: body.accessToken };
}

chrome.runtime.onMessage.addListener((message: { type?: string; stationId?: string }, _sender, sendResponse) => {
  if (message?.type !== 'auth:refresh' || !message.stationId) return undefined;
  const id = message.stationId;
  let flight = inflight.get(id);
  if (!flight) {
    flight = refreshTokens(id).finally(() => {
      inflight.delete(id);
    });
    inflight.set(id, flight);
  }
  flight.then(sendResponse);
  return true; // async sendResponse
});
