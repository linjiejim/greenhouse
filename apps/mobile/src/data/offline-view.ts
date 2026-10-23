/**
 * What a screen with an offline copy shows. React-free (./offline-view.test.ts). The copy saved
 * on this phone shows at once while the station is asked (cache first); the station's answer
 * replaces it and is saved again. When the station cannot be reached (no answer, 502/503/504) the
 * copy stays, marked offline (离线中). When the station says it is gone or no longer mine (403 /
 * 404 / 410) the copy is deleted and stops showing. Any other error shows the error, not the copy.
 * The same rules as knowledge documents (./recent-docs.ts `docMiss`).
 */

import { docMiss } from './recent-docs';

export interface OfflineView<T> {
  data: T | null;
  /** Showing the saved copy because the station is unreachable. */
  offline: boolean;
  /** The saved copy must be deleted. */
  evict: boolean;
}

export function offlineView<T>(input: {
  fresh: T | null;
  saved: T | null;
  loading: boolean;
  /** The last load's HTTP status when it missed (0 = no answer), or null. */
  missStatus: number | null;
}): OfflineView<T> {
  if (input.fresh !== null) return { data: input.fresh, offline: false, evict: false };
  if (input.missStatus === null || input.loading) return { data: input.saved, offline: false, evict: false };
  const miss = docMiss(input.missStatus);
  if (miss === 'gone') return { data: null, offline: false, evict: input.saved !== null };
  if (miss === 'unreachable') return { data: input.saved, offline: input.saved !== null, evict: false };
  return { data: null, offline: false, evict: false };
}
