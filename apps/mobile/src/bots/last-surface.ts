/**
 * The Bots thread to reopen on a cold start (D3): set when a thread is entered,
 * cleared when the member moves to any chat / new chat or the thread is gone
 * (404 / 403). Kept per station + account in prefs (`lastThreads`), and only
 * `{ c, title }` — no transcript is ever written to disk (D19).
 */

import { useAuth } from '../store/auth';
import { usePrefs } from '../store/prefs';
import { useStations } from '../store/stations';

export interface LastThread {
  c: string;
  title: string;
}

/** `${stationId}:${userId}`, or null while signed out / without a station. */
function surfaceKey(): string | null {
  const stationId = useStations.getState().activeId;
  const userId = useAuth.getState().user?.id;
  return stationId && userId ? `${stationId}:${userId}` : null;
}

/** The thread left open last time; null before prefs are hydrated (the caller waits, then gives up). */
export function lastThread(): LastThread | null {
  const prefs = usePrefs.getState();
  const key = surfaceKey();
  if (!prefs.hydrated || !key) return null;
  return prefs.lastThreads[key] ?? null;
}

export function rememberThread(t: LastThread): void {
  const key = surfaceKey();
  if (key && t.c) usePrefs.getState().setLastThread(key, { c: t.c, title: t.title });
}

export function forgetThread(): void {
  const key = surfaceKey();
  if (key) usePrefs.getState().setLastThread(key, null);
}
