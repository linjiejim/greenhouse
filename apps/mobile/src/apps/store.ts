/**
 * Apps cache (zustand): the center's shelves (`GET /api/apps` — mine / shared
 * with me / featured), my pins (server-stored, apps spec D9 — the drawer's Apps
 * section reads them too) and each app's runtime view (my role's trimmed spec).
 * Same rules as the Tables cache (src/tables/store.ts): passive loads share the
 * request in flight, a definitive 403 / 404 drops the cached copy, and the
 * cache is cleared when the account or the station changes. Pinning is
 * optimistic (the server's answer wins; a refusal rolls back and alerts).
 */

import { create } from 'zustand';
import { getApp, listApps, listPins, setPins } from '../api/apps';
import type { AppListView, AppRuntimeView, AppSummary } from '../shared/apps';
import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';

interface AppsState {
  catalog: AppListView | null;
  catalogFailed: boolean;
  pins: AppSummary[] | null;
  views: Record<number, AppRuntimeView | undefined>;
  /** Last load of this app failed: `gone` = 403 / 404 (archived, unshared), else transient. */
  viewFailed: Record<number, 'gone' | 'offline' | undefined>;
  /** Bumped by every write through an app; its cards and record pages refetch when it moves. */
  writes: Record<number, number>;

  loadCatalog: () => Promise<void>;
  loadPins: () => Promise<void>;
  loadApp: (appId: number) => Promise<AppRuntimeView | null>;
  /** A write went through this app (an action, a form, an edit): its cards refetch. */
  written: (appId: number) => void;
  /** Pin / unpin; false when the server refused (the change is rolled back). */
  setPinned: (app: AppSummary, pinned: boolean) => Promise<boolean>;
  reset: () => void;
}

let generation = 0;
let catalogPromise: Promise<void> | null = null;
let pinsPromise: Promise<void> | null = null;
const appPromises = new Map<number, Promise<AppRuntimeView | null>>();

export const useApps = create<AppsState>((set, get) => ({
  catalog: null,
  catalogFailed: false,
  pins: null,
  views: {},
  viewFailed: {},
  writes: {},

  loadCatalog() {
    if (catalogPromise) return catalogPromise;
    const gen = generation;
    catalogPromise = listApps()
      .then((result) => {
        if (gen !== generation) return;
        if (result.ok) set({ catalog: result.value, catalogFailed: false });
        else set({ catalogFailed: true });
      })
      .finally(() => {
        catalogPromise = null;
      });
    return catalogPromise;
  },

  loadPins() {
    if (pinsPromise) return pinsPromise;
    const gen = generation;
    pinsPromise = listPins()
      .then((result) => {
        if (gen === generation && result.ok) set({ pins: result.value });
      })
      .finally(() => {
        pinsPromise = null;
      });
    return pinsPromise;
  },

  loadApp(appId) {
    const running = appPromises.get(appId);
    if (running) return running;
    const gen = generation;
    const promise = getApp(appId)
      .then((result) => {
        if (gen !== generation) return null;
        if (result.ok) {
          set((s) => ({
            views: { ...s.views, [appId]: result.value },
            viewFailed: { ...s.viewFailed, [appId]: undefined },
          }));
          return result.value;
        }
        set((s) => {
          const views = { ...s.views };
          if (result.definitive) delete views[appId];
          return { views, viewFailed: { ...s.viewFailed, [appId]: result.definitive ? 'gone' : 'offline' } };
        });
        return result.definitive ? null : (get().views[appId] ?? null);
      })
      .finally(() => {
        appPromises.delete(appId);
      });
    appPromises.set(appId, promise);
    return promise;
  },

  written(appId) {
    set((s) => ({ writes: { ...s.writes, [appId]: (s.writes[appId] ?? 0) + 1 } }));
  },

  async setPinned(app, pinned) {
    const before = get().pins ?? [];
    const next = pinned
      ? [...before.filter((entry) => entry.id !== app.id), { ...app, pinned: true }]
      : before.filter((entry) => entry.id !== app.id);
    set({ pins: next });
    const result = await setPins(next.map((entry) => entry.id));
    if (!result.ok) {
      set({ pins: before });
      return false;
    }
    set({ pins: result.value });
    // the shelves carry `pinned` too
    void get().loadCatalog();
    return true;
  },

  reset() {
    generation++;
    catalogPromise = null;
    pinsPromise = null;
    appPromises.clear();
    set({ catalog: null, catalogFailed: false, pins: null, views: {}, viewFailed: {}, writes: {} });
  },
}));

useAuth.subscribe((s, prev) => {
  if ((s.user?.id ?? null) !== (prev.user?.id ?? null)) useApps.getState().reset();
});
useStations.subscribe((s, prev) => {
  if (s.activeId !== prev.activeId) useApps.getState().reset();
});

/** Every app on the shelves once (mine first), for lookups by id / Base. */
export function catalogApps(catalog: AppListView | null): AppSummary[] {
  if (!catalog) return [];
  const seen = new Map<number, AppSummary>();
  for (const app of [...catalog.managed, ...catalog.shared, ...catalog.featured])
    if (!seen.has(app.id)) seen.set(app.id, app);
  return [...seen.values()];
}
