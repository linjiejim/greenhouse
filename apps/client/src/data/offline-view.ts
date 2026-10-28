/**
 * What a screen with an offline copy shows. React-free (./offline-view.test.ts). The copy saved
 * on this phone shows at once while the station is asked (cache first); the station's answer
 * replaces it and is saved again. The latest refresh's error decides what shows, even when an
 * earlier answer is still in memory: when the station cannot be reached (no answer, 502/503/504)
 * the last copy (the earlier answer, else the saved one) stays, marked offline (离线中); when the
 * station says it is gone or no longer mine (403 / 404 / 410) the copy on disk is deleted (whether
 * or not it was read into memory) and nothing shows; any other error shows the error, not a copy.
 * The same rules as knowledge documents (./recent-docs.ts `docMiss`).
 */

import { docMiss } from './recent-docs';

export interface OfflineView<T> {
  data: T | null;
  /** Showing a kept copy because the station is unreachable. */
  offline: boolean;
  /** The copy saved on disk must be deleted. */
  evict: boolean;
}

export function offlineView<T>(input: {
  /** The station's last good answer still in memory, or null. */
  fresh: T | null;
  saved: T | null;
  /** The latest load's HTTP status when it missed (0 = no answer), or null when it succeeded. */
  missStatus: number | null;
}): OfflineView<T> {
  const kept = input.fresh ?? input.saved;
  if (input.missStatus === null) return { data: kept, offline: false, evict: false };
  const miss = docMiss(input.missStatus);
  if (miss === 'gone') return { data: null, offline: false, evict: true };
  if (miss === 'unreachable') return { data: kept, offline: kept !== null, evict: false };
  return { data: null, offline: false, evict: false };
}
