/**
 * The active station's manifest for the signed-in member. Cache first: the copy saved for this
 * station + member (src/data/disk-cache.ts) shows its places until the station answers, so a cold
 * start without a network keeps them; a failed refresh keeps what is on screen.
 */
import { create } from 'zustand';
import { api } from '../api/client';
import { readCache, writeCache } from '../data/disk-cache';
import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';
import { fetchManifest, parseManifest, PENDING_MANIFEST, type ManifestState } from './manifest';
interface State {
  data: ManifestState;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  refresh: () => Promise<void>;
}
const CACHE_KIND = 'station-manifest';
let generation = 0;
const who = () => ({ station: useStations.getState().activeId, member: useAuth.getState().user?.id });
const identity = () => {
  const { station, member } = who();
  return `${station ?? ''}:${member ?? ''}`;
};
export const useStationManifest = create<State>((set) => ({
  data: PENDING_MANIFEST,
  status: 'idle',
  error: null,
  async refresh() {
    const key = identity();
    const gen = ++generation;
    if (!useAuth.getState().user) {
      set({ data: PENDING_MANIFEST, status: 'idle', error: null });
      return;
    }
    set({ status: 'loading', error: null });
    try {
      const data = await fetchManifest(() => api('/api/extensions'));
      if (gen === generation && key === identity()) {
        set({ data, status: 'ready' });
        const { station, member } = who();
        if (station && member && data.kind === 'v2') writeCache(station, member, CACHE_KIND, data.manifest);
      }
    } catch (error) {
      if (gen === generation && key === identity())
        set({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  },
}));
/** The saved copy for the identity now active, while the station has not answered for it. */
async function hydrateFromCache(key: string): Promise<void> {
  const { station, member } = who();
  if (!station || !member) return;
  const saved = await readCache(station, member, CACHE_KIND);
  if (!saved || key !== identity() || useStationManifest.getState().data.kind !== 'pending') return;
  try {
    useStationManifest.setState({ data: parseManifest(saved) });
  } catch {
    // a copy this build cannot read is no copy
  }
}
let previous = '';
function follow() {
  const next = identity();
  if (previous === next) return;
  previous = next;
  ++generation;
  useStationManifest.setState({ data: PENDING_MANIFEST, status: 'idle', error: null });
  if (useAuth.getState().user) {
    void hydrateFromCache(next);
    void useStationManifest.getState().refresh();
  }
}
useAuth.subscribe(follow);
useStations.subscribe(follow);
