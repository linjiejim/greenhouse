import { useCallback, useState } from 'react';

const STORAGE_PREFIX = 'pageSize:';

/**
 * Page-size state persisted to localStorage, for the shared <Pagination> control.
 *
 * Each list passes a stable `key` (e.g. 'dashboard.inquiries') so a user's chosen
 * rows-per-page (20/50/100) survives reloads and navigation. Returns the tuple
 * `[pageSize, setPageSize]` — call the setter from <Pagination onPageSizeChange>.
 *
 * Callers are responsible for resetting their page index to 0 on change (they
 * already track `page` state); this hook only owns the size value.
 */
export function usePersistedPageSize(key: string, defaultSize = 20): [number, (size: number) => void] {
  const storageKey = STORAGE_PREFIX + key;

  const [pageSize, setPageSizeState] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      const parsed = raw ? parseInt(raw, 10) : NaN;
      return !isNaN(parsed) && parsed > 0 ? parsed : defaultSize;
    } catch {
      return defaultSize;
    }
  });

  const setPageSize = useCallback(
    (size: number) => {
      setPageSizeState(size);
      try {
        localStorage.setItem(storageKey, String(size));
      } catch {
        /* ignore quota / private-mode errors */
      }
    },
    [storageKey],
  );

  return [pageSize, setPageSize];
}
