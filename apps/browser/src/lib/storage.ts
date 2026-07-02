/**
 * Extension storage — a single typed slot in chrome.storage.local holding the
 * connection state (server URL + tokens + user). The user's password is never
 * stored; only the token pair from /api/auth/login survives, and the refresh
 * rotation in the background worker keeps the session alive.
 */

export interface AuthUser {
  id: string;
  email?: string;
  nickname: string;
  role: string;
  locale?: string;
}

export interface StoredAuth {
  /** Normalized origin of the Greenhouse instance, no trailing slash. */
  baseUrl: string;
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

const AUTH_KEY = 'auth';

export async function getAuth(): Promise<StoredAuth | null> {
  const record = await chrome.storage.local.get(AUTH_KEY);
  return (record[AUTH_KEY] as StoredAuth | undefined) ?? null;
}

export async function setAuth(auth: StoredAuth | null): Promise<void> {
  if (auth) {
    await chrome.storage.local.set({ [AUTH_KEY]: auth });
  } else {
    await chrome.storage.local.remove(AUTH_KEY);
  }
}

/** Subscribe to auth changes (login/logout/rotation) from any extension context. */
export function onAuthChange(cb: (auth: StoredAuth | null) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && AUTH_KEY in changes) {
      cb((changes[AUTH_KEY].newValue as StoredAuth | undefined) ?? null);
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
