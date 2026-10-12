/**
 * What a cold start can open without the network (D3; spec 20261011 §3.1), kept
 * per station + account in prefs, and only `{ c, title }` — no transcript is
 * ever written to disk (D19):
 *
 * - the last thread (`lastThreads`): set when a thread is entered, cleared when
 *   the member moves to any chat / new chat or the thread is gone (404 / 403);
 * - the main thread (`mainThreads`): Sprouty's DM as the Bots store last knew it
 *   (the home dispatcher writes it whenever the store learns it), so a cold
 *   start with no last thread opens the main thread before the Bot list loads.
 *   Moving to a chat keeps it; only a gone thread drops it.
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

/** The main thread remembered for this station + account; null before prefs are hydrated (like `lastThread`). */
export function mainThread(): LastThread | null {
  const prefs = usePrefs.getState();
  const key = surfaceKey();
  if (!prefs.hydrated || !key) return null;
  return prefs.mainThreads[key] ?? null;
}

/** Remember Sprouty's DM as this station + account's main thread (a no-op when nothing changed). */
export function rememberMainThread(t: LastThread): void {
  const key = surfaceKey();
  if (key && t.c) usePrefs.getState().setMainThread(key, { c: t.c, title: t.title });
}

/**
 * A thread answered 404 / 403: no cold start reopens it — neither as the last thread nor, when it
 * is the remembered main thread, as that (the Bots store's next answer remembers the real one).
 */
export function forgetGoneThread(c: string): void {
  forgetThread();
  const key = surfaceKey();
  const prefs = usePrefs.getState();
  if (key && c && prefs.mainThreads[key]?.c === c) prefs.setMainThread(key, null);
}
