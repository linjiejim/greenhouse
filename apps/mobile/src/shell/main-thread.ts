/**
 * The main thread is where the app lands (CONV-01). Its id comes from the directory
 * (`GET /api/conversations`, kind `main`); it is remembered per station + member in prefs (only
 * the id and title — no transcript on disk), so a cold start opens it before the network answers.
 */

import { useAuth } from '../store/auth';
import { usePrefs, type MainThreadPref } from '../store/prefs';
import { useStations } from '../store/stations';

/** `${stationId}:${userId}`, or null while signed out / without a station. */
function key(): string | null {
  const stationId = useStations.getState().activeId;
  const userId = useAuth.getState().user?.id;
  return stationId && userId ? `${stationId}:${userId}` : null;
}

/** The main thread remembered for this station + member; null before prefs are hydrated. */
export function rememberedMainThread(): MainThreadPref | null {
  const prefs = usePrefs.getState();
  const k = key();
  if (!prefs.hydrated || !k) return null;
  return prefs.mainThreads[k] ?? null;
}

/** Remember the directory's main thread for this station + member (a no-op when nothing changed). */
export function rememberMainThread(thread: MainThreadPref): void {
  const k = key();
  if (k && thread.c) usePrefs.getState().setMainThread(k, thread);
}

/** The remembered one answered 404: never open it again. */
export function forgetMainThread(): void {
  const k = key();
  if (k) usePrefs.getState().setMainThread(k, null);
}
