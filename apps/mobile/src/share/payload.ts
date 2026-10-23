/**
 * What the share extension ("存到 Greenhouse", targets/share) may know: the active station and a
 * short-lived access token for it — never the refresh token (a single-use refresh in the
 * extension would sign the app out). React-free (./payload.test.ts). The app keeps it in the
 * keychain under the App Group (./session.ts); the extension reads it and uploads to Files.
 */

/** The keychain item the app writes and targets/share/ShareModel.swift reads. */
export const SHARE_SESSION_KEY = 'greenhouse.share.session';
export const SHARE_KEYCHAIN_SERVICE = 'greenhouse.share';
export const SHARE_ACCESS_GROUP = 'group.app.greenhouse.mobile';

export interface ShareSession {
  v: 1;
  stationId: string;
  stationName: string;
  baseUrl: string;
  accessToken: string;
  memberName: string;
  /** Epoch seconds the token expires at (from its `exp`), when readable. */
  expiresAt: number | null;
}

/** The `exp` of a JWT, or null. */
export function tokenExpiry(token: string): number | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const json = JSON.parse(globalThis.atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: unknown };
    return typeof json.exp === 'number' ? json.exp : null;
  } catch {
    return null;
  }
}

/** The payload for the active station + member, or null when nobody is signed in there. */
export function sharePayload(input: {
  station: { id: string; name: string; baseUrl: string } | null;
  accessToken: string | null;
  memberName: string | null;
}): ShareSession | null {
  if (!input.station || !input.accessToken || !input.memberName) return null;
  if (!/^https?:\/\//.test(input.station.baseUrl)) return null;
  return {
    v: 1,
    stationId: input.station.id,
    stationName: input.station.name,
    baseUrl: input.station.baseUrl.replace(/\/+$/, ''),
    accessToken: input.accessToken,
    memberName: input.memberName,
    expiresAt: tokenExpiry(input.accessToken),
  };
}
