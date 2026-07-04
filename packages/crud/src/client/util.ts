/** Small internals shared by the CRUD client components. */

import { useCallback, useState } from 'react';

/** Translate a label only when it looks like a dotted i18n key; pass literals through. */
export function tr(t: (k: string, p?: Record<string, string | number>) => string, label: string): string {
  return /^[\w-]+(\.[\w-]+)+$/.test(label) ? t(label) : label;
}

/** localStorage-backed page size (the app-level hook lives in apps/web; this keeps
 *  the package self-contained). */
export function usePersistedPageSize(key: string, defaultSize = 20): [number, (size: number) => void] {
  const storageKey = `crud-page-size:${key}`;
  const [size, setSizeState] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(storageKey));
      return Number.isFinite(v) && v > 0 ? v : defaultSize;
    } catch {
      return defaultSize;
    }
  });
  const setSize = useCallback(
    (next: number) => {
      setSizeState(next);
      try {
        localStorage.setItem(storageKey, String(next));
      } catch {
        /* ignore */
      }
    },
    [storageKey],
  );
  return [size, setSize];
}

/** Format a value for read-only display in columns/detail. */
export function formatCell(type: string | undefined, value: unknown): string {
  if (value == null || value === '') return '—';
  switch (type) {
    case 'date':
      return new Date(String(value)).toLocaleDateString();
    case 'datetime':
      return new Date(String(value)).toLocaleString();
    case 'boolean':
      return value ? '✓' : '—';
    default:
      return String(value);
  }
}
