import { create } from 'zustand';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';
import { fetchManifest, LEGACY_MANIFEST, type ManifestState } from './manifest';
interface State {
  data: ManifestState;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  refresh: () => Promise<void>;
}
let generation = 0;
const identity = () => `${useStations.getState().activeId ?? ''}:${useAuth.getState().user?.id ?? ''}`;
export const useStationManifest = create<State>((set) => ({
  data: LEGACY_MANIFEST,
  status: 'idle',
  error: null,
  async refresh() {
    const key = identity();
    const gen = ++generation;
    if (!useAuth.getState().user) {
      set({ data: LEGACY_MANIFEST, status: 'idle', error: null });
      return;
    }
    set({ status: 'loading', error: null });
    try {
      const data = await fetchManifest(() => api('/api/extensions'));
      if (gen === generation && key === identity()) set({ data, status: 'ready' });
    } catch (error) {
      if (gen === generation && key === identity())
        set({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  },
}));
let previous = '';
function follow() {
  const next = identity();
  if (previous === next) return;
  previous = next;
  ++generation;
  useStationManifest.setState({ data: LEGACY_MANIFEST, status: 'idle', error: null });
  if (useAuth.getState().user) void useStationManifest.getState().refresh();
}
useAuth.subscribe(follow);
useStations.subscribe(follow);
