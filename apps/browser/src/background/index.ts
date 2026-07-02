/**
 * Background service worker.
 *
 * Owns the refresh-token rotation: pages send {type: 'auth:refresh'} instead
 * of refreshing themselves, so a single in-flight refresh serves all contexts
 * (rotation revokes the old token — two racing refreshes would log the user
 * out). On an invalid/expired refresh token the stored auth is cleared, which
 * every page observes via storage.onChanged and falls back to the login flow.
 */

import { getAuth, setAuth, type StoredAuth } from '../lib/storage';

// Clicking the toolbar icon opens the side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
  // Older Chrome without sidePanel behavior API — user can still open it via the panel picker.
});

// ─── Single-flight token refresh ─────────────────────────

let inflight: Promise<{ ok: boolean; accessToken?: string }> | null = null;

async function refreshTokens(): Promise<{ ok: boolean; accessToken?: string }> {
  const auth = await getAuth();
  if (!auth) return { ok: false };

  let res: Response;
  try {
    res = await fetch(`${auth.baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: auth.refreshToken }),
    });
  } catch {
    // Network error — keep the stored pair, the next call may succeed.
    return { ok: false };
  }

  if (res.status === 401) {
    // Rotation dead (revoked/expired) — force re-login.
    await setAuth(null);
    return { ok: false };
  }
  if (!res.ok) return { ok: false };

  const body = (await res.json().catch(() => null)) as {
    accessToken?: string;
    refreshToken?: string;
    user?: StoredAuth['user'];
  } | null;
  if (!body?.accessToken || !body.refreshToken || !body.user) return { ok: false };

  await setAuth({
    baseUrl: auth.baseUrl,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    user: body.user,
  });
  return { ok: true, accessToken: body.accessToken };
}

chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
  if (message?.type !== 'auth:refresh') return undefined;
  if (!inflight) {
    inflight = refreshTokens().finally(() => {
      inflight = null;
    });
  }
  inflight.then(sendResponse);
  return true; // async sendResponse
});
