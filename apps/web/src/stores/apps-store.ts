/**
 * Apps store — the caller's app shelves (`GET /api/apps`) and pins (D9, kept on
 * the server so they survive reloads and follow the member across devices).
 *
 * Consumed by the sidebar's Apps section and the app center. It only caches
 * what the gateway decided the caller may see; it never widens access. Shared
 * in-flight load; `clear()` on sign-out drops the previous member's apps and
 * makes an answer still in flight for them land nowhere.
 */

import { create } from 'zustand';
import type { AppSummary } from '@greenhouse/types/apps';
import { getAppPins, listApps, setAppPins, type AppCatalog } from '../lib/api/apps';

export type AppsLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface AppsState {
  catalog: AppCatalog | null;
  /** Pinned app ids in sidebar order — the store's truth (an optimistic pin shows at once). */
  pinnedIds: number[];
  status: AppsLoadStatus;
  error: string | null;
  /** Load once; concurrent callers share the request. `force` refetches. */
  load: (force?: boolean) => Promise<void>;
  /** Pin (appended last) or unpin an app, then refetch the shelves. */
  setPinned: (appId: number, pinned: boolean) => Promise<void>;
  clear: () => void;
}

let inFlight: Promise<void> | null = null;
/** Bumped by `clear()`: a load started for the previous member must not land. */
let generation = 0;

/** Every app on any shelf, once (managed, then shared, then featured). */
export function catalogApps(catalog: AppCatalog | null): AppSummary[] {
  if (!catalog) return [];
  const seen = new Set<number>();
  const out: AppSummary[] = [];
  for (const app of [...catalog.managed, ...catalog.shared, ...catalog.featured]) {
    if (seen.has(app.id)) continue;
    seen.add(app.id);
    out.push(app);
  }
  return out;
}

/**
 * The sidebar's Apps section: the caller's pins in their order, then featured
 * apps not already pinned. Archived apps never show; a pin whose app is no
 * longer on any shelf (unshared, archived) simply drops out.
 */
export function sidebarApps(catalog: AppCatalog | null, pinnedIds: readonly number[]) {
  const apps = catalogApps(catalog).filter((app) => app.status !== 'archived');
  const byId = new Map(apps.map((app) => [app.id, app]));
  const pinned = [...new Set(pinnedIds)].flatMap((id) => {
    const app = byId.get(id);
    return app ? [app] : [];
  });
  const pinnedSet = new Set(pinned.map((app) => app.id));
  const featured = (catalog?.featured ?? []).filter((app) => app.status !== 'archived' && !pinnedSet.has(app.id));
  return { pinned, featured };
}

export const useAppsStore = create<AppsState>((set, get) => ({
  catalog: null,
  pinnedIds: [],
  status: 'idle',
  error: null,

  load: (force = false) => {
    // A forced load (after a pin) must see writes made while an earlier load was running.
    if (inFlight) return force ? inFlight.then(() => get().load(true)) : inFlight;
    if (!force && get().status === 'ready') return Promise.resolve();
    const startedFor = generation;
    set({ status: 'loading', error: null });
    const run = async () => {
      try {
        // Pins are an ordering hint; the shelves still say which apps are pinned.
        const [catalog, pinnedIds] = await Promise.all([listApps(), getAppPins().catch(() => null)]);
        if (startedFor !== generation) return;
        set({
          catalog,
          pinnedIds:
            pinnedIds ??
            catalogApps(catalog)
              .filter((app) => app.pinned)
              .map((app) => app.id),
          status: 'ready',
          error: null,
        });
      } catch (loadError) {
        if (startedFor !== generation) return;
        set({ status: 'error', error: loadError instanceof Error ? loadError.message : String(loadError) });
      }
    };
    const request: Promise<void> = run().finally(() => {
      if (inFlight === request) inFlight = null;
    });
    inFlight = request;
    return request;
  },

  setPinned: async (appId, pinned) => {
    const previous = get().pinnedIds;
    const next = pinned ? [...previous.filter((id) => id !== appId), appId] : previous.filter((id) => id !== appId);
    set({ pinnedIds: next });
    try {
      await setAppPins(next);
    } catch (pinError) {
      set({ pinnedIds: previous });
      throw pinError;
    }
    await get().load(true);
  },

  clear: () => {
    generation += 1;
    inFlight = null;
    set({ catalog: null, pinnedIds: [], status: 'idle', error: null });
  },
}));
