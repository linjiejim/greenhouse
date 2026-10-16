/**
 * The session in this browser. It lives in localStorage so every tab shares it and a reload
 * keeps it; refreshes are serialized across tabs with a Web Lock, because a refresh token is
 * single-use and two tabs spending the same one would end the session.
 */

import type { TokenPair } from '@greenhouse/contract';
import type { TokenStore } from '@greenhouse/contract/client';

const KEY = 'greenhouse.session';

function read(): TokenPair | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as TokenPair) : null;
  } catch {
    return null;
  }
}

export const browserTokens: TokenStore = {
  get: read,
  set(tokens) {
    if (tokens) localStorage.setItem(KEY, JSON.stringify(tokens));
    else localStorage.removeItem(KEY);
  },
  lock<T>(run: () => Promise<T>): Promise<T> {
    if (!navigator.locks) return run();
    return navigator.locks.request('greenhouse.refresh', run) as Promise<T>;
  },
};

/** Another tab signed in or out. */
export function onOtherTab(listener: (signedIn: boolean) => void) {
  const handle = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) listener(read() !== null);
  };
  window.addEventListener('storage', handle);
  return () => window.removeEventListener('storage', handle);
}
