/**
 * Zustand store for the permission-aware application catalog.
 *
 * The server remains authoritative; local state is only a cached projection of
 * `/api/platform/apps`.
 */

import { useMemo } from 'react';
import { create } from 'zustand';
import { authFetch } from '../lib/auth';
import { orderPlatformApplications, type PlatformApplication } from '../platform/catalog';

interface PlatformStore {
  applications: PlatformApplication[];
  loading: boolean;
  error: string | null;
  enabled: boolean;
  load: (enabled: boolean) => Promise<void>;
  refresh: () => Promise<void>;
}

export const usePlatformStore = create<PlatformStore>((set, get) => ({
  applications: [],
  loading: false,
  error: null,
  enabled: false,

  load: async (enabled) => {
    set({ enabled });
    if (!enabled) {
      set({ applications: [], loading: false, error: null });
      return;
    }
    set({ loading: true });
    try {
      const response = await authFetch('/api/platform/apps');
      if (!response.ok) throw new Error('Unable to load your application catalog');
      const catalog = (await response.json()) as { applications: PlatformApplication[] };
      set({ applications: catalog.applications, error: null });
    } catch (loadError) {
      set({
        applications: [],
        error: loadError instanceof Error ? loadError.message : 'Unable to load your application catalog',
      });
    } finally {
      set({ loading: false });
    }
  },

  refresh: async () => get().load(get().enabled),
}));

export function usePlatformCatalog() {
  const state = usePlatformStore();
  const orderedApplications = useMemo(() => orderPlatformApplications(state.applications), [state.applications]);
  const hasApplication = (appId: string) => state.applications.some((application) => application.id === appId);
  return {
    ...state,
    orderedApplications,
    hasApplication,
  };
}
