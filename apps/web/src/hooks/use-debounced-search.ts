/**
 * Shared debounced search hook for remote-search Select/MultiSelect fields.
 *
 * Centralizes the pattern: user types → debounce 300ms → call remote search fn.
 */

import { useState, useRef, useEffect, useCallback } from 'react';

interface UseDebouncedSearchOptions {
  /** Remote search function (query → Promise<void>) */
  onSearch: (query: string) => void;
  /** Debounce delay in ms. Default: 300 */
  delay?: number;
}

/**
 * Returns `[query, setQuery]` where `setQuery` auto-debounces calls to `onSearch`.
 */
export function useDebouncedSearch({ onSearch, delay = 300 }: UseDebouncedSearchOptions) {
  const [query, setQueryRaw] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const setQuery = useCallback(
    (q: string) => {
      setQueryRaw(q);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => onSearch(q), delay);
    },
    [onSearch, delay],
  );

  const reset = useCallback(() => {
    setQueryRaw('');
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return { query, setQuery, reset } as const;
}
