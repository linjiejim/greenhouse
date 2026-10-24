/**
 * Titles for object chips — `POST /api/refs/resolve`, batched and cached.
 *
 * Every chip on screen asks for its URL; asks made in the same tick go out as one request
 * (≤ MAX_RESOLVE_URLS each), and answers are cached for the session (5 minutes), so a long
 * transcript full of the same document link costs one lookup. A URL the server leaves out
 * (it names no object) is cached as `null`, like an object the member may not read; a
 * failed request is retried on the next ask after a short pause.
 *
 * Titles are private to the member who asked: the cache belongs to the signed-in member, is
 * emptied when another member signs in (same tab), and an answer still in flight for the
 * previous member is thrown away.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { MAX_RESOLVE_URLS, type ResolvedObjectRef, type ResolveRefsResponse } from '@greenhouse/types/object-refs';
import { useAuthStore } from '../stores/auth-store';
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
/** Who the cache belongs to, and a counter that outdates requests made for someone else. */
let owner: string | null = null;
let generation = 0;

const LOADING: RefLookup = { status: 'loading' };

function notify(): void {
  for (const listener of listeners) listener();
}

function settle(url: string, lookup: RefLookup): void {
  cache.set(url, { lookup, at: Date.now() });
}

function clearCache(): void {
  generation += 1;
  cache.clear();
  queue.clear();
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Empty the cache when the signed-in member is not the one it was filled for. */
function followMember(): void {
  const current = useAuthStore.getState().currentUser?.id ?? null;
  if (current === owner) return;
  owner = current;
  clearCache();
  notify();
}
useAuthStore.subscribe(followMember);

async function flush(): Promise<void> {
  timer = null;
  const asked = generation;
  const urls = [...queue];
  queue.clear();
  for (let i = 0; i < urls.length; i += MAX_RESOLVE_URLS) {
    if (asked !== generation) return;
    const batch = urls.slice(i, i + MAX_RESOLVE_URLS);
    let answers: RefLookup[];
    try {
      const res = await authFetch('/api/refs/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: batch }),
      });
      if (!res.ok) throw new Error(`resolve ${res.status}`);
      const { items } = (await res.json()) as ResolveRefsResponse;
      const byUrl = new Map(items.map((item) => [item.url, item]));
      answers = batch.map((url) => ({ status: 'done', item: byUrl.get(url) ?? null }));
    } catch {
      answers = batch.map(() => ({ status: 'error' }));
    }
    // asked for a member who has since signed out
    if (asked !== generation) return;
    batch.forEach((url, index) => settle(url, answers[index]!));
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
  followMember();
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

/** Test hooks. */
export function _resetObjectRefCache(): void {
  clearCache();
  owner = useAuthStore.getState().currentUser?.id ?? null;
}

export function _readObjectRef(url: string): RefLookup | undefined {
  return cache.get(url)?.lookup;
}
