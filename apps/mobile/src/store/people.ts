/**
 * Member names for plugin record fields, resolved in batches through `POST /api/people/resolve`
 * and kept for the station + member that asked (cleared on any change). A station without the
 * endpoint (404) is not asked again this session: fields keep showing the id. Failed batches are
 * retried on the next screen that asks.
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import { post } from '../api/client';
import { captureIdentity } from '../data/identity';
import { parsePeople, PEOPLE_BATCH } from '../data/people';
import { useAuth } from './auth';
import { useStations } from './stations';

export const usePeople = create<{ names: Record<string, string> }>(() => ({ names: {} }));

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
  usePeople.setState({ names: {} });
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
  const ids = [...queued].slice(0, PEOPLE_BATCH);
  ids.forEach((id) => queued.delete(id));
  if (queued.size) timer = setTimeout(() => void flush(), 0);
  if (!ids.length) return;
  const current = captureIdentity();
  const result = await post<unknown>('/api/people/resolve', { ids });
  if (!current()) return;
  if (!result.ok) {
    if (result.status === 404 || result.status === 405) unsupported.add(station);
    else ids.forEach((id) => asked.delete(id));
    return;
  }
  const names = parsePeople(result.data);
  if (Object.keys(names).length) usePeople.setState((s) => ({ names: { ...s.names, ...names } }));
}

/** id → name for the people known so far; asks the station for the ones in `ids` it has not seen. */
export function usePeopleNames(ids: readonly string[]): Record<string, string> {
  const names = usePeople((s) => s.names);
  const key = ids.join('\n');
  useEffect(() => {
    const station = useStations.getState().activeId;
    if (!station || unsupported.has(station)) return;
    // the signed-in member is known without asking
    const me = useAuth.getState().user;
    let added = false;
    for (const id of key ? key.split('\n') : []) {
      if (asked.has(id)) continue;
      asked.add(id);
      if (me && id === me.id && me.nickname) {
        usePeople.setState((s) => ({ names: { ...s.names, [id]: me.nickname } }));
        continue;
      }
      queued.add(id);
      added = true;
    }
    if (added && !timer) timer = setTimeout(() => void flush(), 40);
  }, [key]);
  return names;
}
