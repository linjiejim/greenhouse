/**
 * Profile store — Zustand global state for Agent profiles.
 *
 * Shared between Chat page and Settings > My Profiles so that
 * CRUD operations in settings are instantly reflected in chat.
 */

import { create } from 'zustand';
import type { Profile } from '@greenhouse/types/api';
import { fetchProfilesAndModels, type ChatModel } from '../lib/api/profiles.js';
import type { ToolMeta } from '../lib/api.js';
import * as api from '../lib/api.js';
import { getLastProfile, setLastProfile } from '../lib/profile-preferences.js';

const ANONYMOUS_PREFERENCE_KEY = '__anonymous__';

function preferenceKey(userId?: string): string {
  return userId || ANONYMOUS_PREFERENCE_KEY;
}

interface ProfileState {
  /** All profiles (system + custom) from GET /api/profiles */
  profiles: Profile[];
  /** Models the user may switch between per turn (same endpoint). */
  models: ChatModel[];
  /** Available tools for custom profile editing */
  availableTools: ToolMeta[];
  /** Loading state for initial fetch */
  loading: boolean;
  /** Whether profiles have been fetched at least once */
  initialized: boolean;
  /** Live, per-user profile preference shared by every conversation surface. */
  preferredProfileIds: Record<string, string | null>;

  // ─── Actions ──────────────────────────────────

  /** Fetch all profiles (system + custom). Idempotent if already loaded. */
  fetchProfiles: (force?: boolean) => Promise<void>;
  /** Fetch available tools for custom profile editing. */
  fetchTools: () => Promise<void>;
  /** Refresh profiles after CRUD (always re-fetches). */
  refresh: () => Promise<void>;
  /** Load the persisted default Agent into the live shared store. */
  hydratePreferredProfile: (userId?: string) => string | null;
  /** Persist and broadcast the default Agent to every mounted conversation surface. */
  setPreferredProfile: (profileId: string, userId?: string) => void;
  /** Clear store (e.g. on logout). */
  clear: () => void;
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  profiles: [],
  models: [],
  availableTools: [],
  loading: false,
  initialized: false,
  preferredProfileIds: {},

  fetchProfiles: async (force = false) => {
    const state = get();
    if (state.initialized && !force) return;
    if (state.loading) return; // prevent concurrent fetches

    set({ loading: true });
    try {
      const { profiles, models } = await fetchProfilesAndModels();
      set({ profiles, models, initialized: true });
    } catch (err) {
      console.warn('Failed to load profiles:', err);
    }
    set({ loading: false });
  },

  fetchTools: async () => {
    try {
      const tools = await api.fetchTools();
      set({ availableTools: tools });
    } catch {
      /* ignore */
    }
  },

  refresh: async () => {
    try {
      const { profiles, models } = await fetchProfilesAndModels();
      set({ profiles, models, initialized: true });
    } catch {
      /* ignore */
    }
  },

  hydratePreferredProfile: (userId) => {
    const key = preferenceKey(userId);
    const current = get().preferredProfileIds[key];
    if (current !== undefined) return current;
    const persisted = getLastProfile(userId);
    set((state) => ({
      preferredProfileIds: { ...state.preferredProfileIds, [key]: persisted },
    }));
    return persisted;
  },

  setPreferredProfile: (profileId, userId) => {
    setLastProfile(profileId, userId);
    const key = preferenceKey(userId);
    set((state) => ({
      preferredProfileIds: { ...state.preferredProfileIds, [key]: profileId },
    }));
  },

  clear: () =>
    set({
      profiles: [],
      models: [],
      availableTools: [],
      loading: false,
      initialized: false,
      preferredProfileIds: {},
    }),
}));
