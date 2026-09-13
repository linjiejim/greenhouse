/**
 * Zustand store for the permission-aware application catalog and workbench.
 *
 * The server remains authoritative; local state is only a cached projection of
 * `/api/platform/apps` and `/api/platform/me/workbench`.
 */

import { useMemo } from 'react';
import { create } from 'zustand';
import { authFetch } from '../lib/auth';
import {
  DEFAULT_WORKBENCH_PREFERENCES,
  normalizeWorkbenchPreferences,
  orderPlatformApplications,
  selectPrimaryNavigationApplications,
  type PlatformApplication,
  type WorkbenchPreferences,
} from '../platform/catalog';

interface PlatformStore {
  applications: PlatformApplication[];
  preferences: WorkbenchPreferences;
  loading: boolean;
  saving: boolean;
  error: string | null;
  enabled: boolean;
  load: (enabled: boolean) => Promise<void>;
  refresh: () => Promise<void>;
  savePreferences: (preferences: WorkbenchPreferences) => Promise<void>;
}

export const usePlatformStore = create<PlatformStore>((set, get) => ({
  applications: [],
  preferences: DEFAULT_WORKBENCH_PREFERENCES,
  loading: false,
  saving: false,
  error: null,
  enabled: false,

  load: async (enabled) => {
    set({ enabled });
    if (!enabled) {
      set({
        applications: [],
        preferences: DEFAULT_WORKBENCH_PREFERENCES,
        loading: false,
        saving: false,
        error: null,
      });
      return;
    }
    set({ loading: true });
    try {
      const [catalogResponse, preferencesResponse] = await Promise.all([
        authFetch('/api/platform/apps'),
        authFetch('/api/platform/me/workbench'),
      ]);
      if (!catalogResponse.ok || !preferencesResponse.ok) {
        throw new Error('Unable to load your application catalog');
      }
      const [catalog, workbench] = await Promise.all([
        catalogResponse.json() as Promise<{
          applications: PlatformApplication[];
        }>,
        preferencesResponse.json() as Promise<{
          preferences: WorkbenchPreferences;
        }>,
      ]);
      set({
        applications: catalog.applications,
        preferences: normalizeWorkbenchPreferences(workbench.preferences),
        error: null,
      });
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

  savePreferences: async (nextPreferences) => {
    const { preferences: previous } = get();
    const normalized = normalizeWorkbenchPreferences(nextPreferences);
    let conflict = false;
    set({ preferences: normalized, saving: true });
    try {
      const response = await authFetch('/api/platform/me/workbench', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: normalized, base: previous }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        preferences?: WorkbenchPreferences;
        error?: string;
      };
      if (!response.ok || !body.preferences) {
        conflict = response.status === 409;
        throw new Error(body.error || 'Unable to save workbench preferences');
      }
      set({
        preferences: normalizeWorkbenchPreferences(body.preferences),
      });
    } catch (saveError) {
      if (conflict) {
        // An Agent or another tab wrote a newer version. Reload that version
        // instead of rolling the UI back to another stale snapshot.
        await get().refresh();
      } else {
        set({ preferences: previous });
      }
      throw saveError;
    } finally {
      set({ saving: false });
    }
  },
}));

export function usePlatformCatalog() {
  const state = usePlatformStore();
  const orderedApplications = useMemo(
    () => orderPlatformApplications(state.applications, state.preferences),
    [state.applications, state.preferences],
  );
  const primaryApplications = useMemo(
    () => selectPrimaryNavigationApplications(state.applications),
    [state.applications],
  );
  const hasApplication = (appId: string) => state.applications.some((application) => application.id === appId);
  return {
    ...state,
    orderedApplications,
    primaryApplications,
    hasApplication,
  };
}
