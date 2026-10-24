/**
 * Titles for object chips — `POST /api/refs/resolve`, batched and cached.
 *
 * Every chip on screen asks for its URL; asks made in the same tick go out as one request
 * (≤ MAX_RESOLVE_URLS each), and answers are cached for the session (5 minutes), so a long
 * transcript full of the same document link costs one lookup. A URL the server leaves out
 * (it names no object) is cached as `null`, like an object the member may not read; a
 * failed request is retried on the next ask after a short pause.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { MAX_RESOLVE_URLS, type ResolvedObjectRef, type ResolveRefsResponse } from '@greenhouse/types/object-refs';
import { authFetch } from './auth';

const FRESH_MS = 5 * 60_000;
const RETRY_MS = 30_000;
const BATCH_DELAY_MS = 16;

export type RefLookup =
  | { status: 'loading' }
  | { status: 'done'; item: ResolvedObjectRef | null }
  | { status: 'error' };

interface Entry {
  lookup: RefLookup;
  at: number;
}

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
const queue = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

const LOADING: RefLookup = { status: 'loading' };

function notify(): void {
  for (const listener of listeners) listener();
}

function settle(url: string, lookup: RefLookup): void {
  cache.set(url, { lookup, at: Date.now() });
}

async function flush(): Promise<void> {
  timer = null;
  const urls = [...queue];
  queue.clear();
  for (let i = 0; i < urls.length; i += MAX_RESOLVE_URLS) {
    const batch = urls.slice(i, i + MAX_RESOLVE_URLS);
    try {
      const res = await authFetch('/api/refs/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: batch }),
      });
      if (!res.ok) throw new Error(`resolve ${res.status}`);
      const { items } = (await res.json()) as ResolveRefsResponse;
      const byUrl = new Map(items.map((item) => [item.url, item]));
      for (const url of batch) settle(url, { status: 'done', item: byUrl.get(url) ?? null });
    } catch {
      for (const url of batch) settle(url, { status: 'error' });
    }
    notify();
  }
}

function stale(entry: Entry | undefined): boolean {
  if (!entry) return true;
  if (entry.lookup.status === 'loading') return false;
  return Date.now() - entry.at > (entry.lookup.status === 'error' ? RETRY_MS : FRESH_MS);
}

/** Ask for a URL's title; the answer arrives through {@link useObjectRef}. */
export function requestObjectRef(url: string): void {
  if (!stale(cache.get(url))) return;
  cache.set(url, { lookup: LOADING, at: Date.now() });
  queue.add(url);
  timer ??= setTimeout(() => void flush(), BATCH_DELAY_MS);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The resolved object behind a link (`null` url → nothing to resolve). */
export function useObjectRef(url: string | null): RefLookup {
  const lookup = useSyncExternalStore(subscribe, () => (url ? cache.get(url)?.lookup : undefined));
  useEffect(() => {
    if (url) requestObjectRef(url);
  }, [url]);
  return lookup ?? LOADING;
}

/** Test hook. */
export function _resetObjectRefCache(): void {
  cache.clear();
  queue.clear();
  if (timer) clearTimeout(timer);
  timer = null;
}
