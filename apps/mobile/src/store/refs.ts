/**
 * Link titles for the chips (src/markdown/link-chip.tsx), resolved in batches through
 * `POST /api/refs/resolve` and kept for the station + member that asked (cleared on any change).
 * A station without the endpoint (404) is not asked again this session: chips keep the link's own
 * words and the object's type. Failed batches are retried on the next link that asks.
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import { post } from '../api/client';
import { captureIdentity } from '../data/identity';
import { parseResolved, RESOLVE_BATCH, type RefInfo } from '../data/refs';
import { useAuth } from './auth';
import { useStations } from './stations';

interface Refs {
  items: Record<string, RefInfo>;
}

export const useRefs = create<Refs>(() => ({ items: {} }));

const queued = new Set<string>();
const asked = new Set<string>();
const unsupported = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

let identity = '';
const follow = () => {
  const next = `${useStations.getState().activeId ?? ''}:${useAuth.getState().user?.id ?? ''}`;
  if (next === identity) return;
  identity = next;
  queued.clear();
  asked.clear();
  useRefs.setState({ items: {} });
};
useAuth.subscribe(follow);
useStations.subscribe(follow);

async function flush(): Promise<void> {
  timer = null;
  const station = useStations.getState().activeId;
  if (!station || unsupported.has(station)) {
    queued.clear();
    return;
  }
  const urls = [...queued].slice(0, RESOLVE_BATCH);
  urls.forEach((url) => queued.delete(url));
  if (queued.size) timer = setTimeout(() => void flush(), 0);
  if (!urls.length) return;
  const current = captureIdentity();
  const result = await post<unknown>('/api/refs/resolve', { urls });
  if (!current()) return;
  if (!result.ok) {
    if (result.status === 404 || result.status === 405) unsupported.add(station);
    else urls.forEach((url) => asked.delete(url));
    return;
  }
  const resolved = parseResolved(result.data);
  if (resolved.size) useRefs.setState((s) => ({ items: { ...s.items, ...Object.fromEntries(resolved) } }));
}

/** The resolved info of a link (undefined until known, or when the station cannot say). */
export function useLinkRef(url: string): RefInfo | undefined {
  const info = useRefs((s) => (url ? s.items[url] : undefined));
  useEffect(() => {
    if (!url || asked.has(url)) return;
    const station = useStations.getState().activeId;
    if (!station || unsupported.has(station)) return;
    asked.add(url);
    queued.add(url);
    if (!timer) timer = setTimeout(() => void flush(), 40);
  }, [url]);
  return info;
}
