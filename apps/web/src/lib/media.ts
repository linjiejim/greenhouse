import { useSyncExternalStore } from 'react';

/** Breakpoints of docs/design-system/layout.md: narrow < 768, medium 768–1023, wide ≥ 1024. */
export const NARROW = '(max-width: 767px)';
export const MEDIUM = '(min-width: 768px) and (max-width: 1023px)';

export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
  );
}

/** A preference kept in this browser. */
export function stored<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const value = localStorage.getItem(`greenhouse.${key}`);
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

export function store(key: string, value: string) {
  try {
    localStorage.setItem(`greenhouse.${key}`, value);
  } catch {
    // Private mode: the preference lasts for this page only.
  }
}

/** Whether the page is on screen; reading marks only count while it is. */
export function useVisible(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      document.addEventListener('visibilitychange', onChange);
      return () => document.removeEventListener('visibilitychange', onChange);
    },
    () => document.visibilityState === 'visible',
  );
}
