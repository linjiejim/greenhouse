/**
 * Profile store — Zustand global state for Agent profiles.
 *
 * Shared between Chat page and Settings > My Profiles so that
 * CRUD operations in settings are instantly reflected in chat.
 */

import { create } from 'zustand';
import type { Profile } from '@greenhouse/types/api';
import type { ToolMeta } from '../lib/api.js';
import * as api from '../lib/api.js';

interface ProfileState {
  /** All profiles (system + custom) from GET /api/profiles */
  profiles: Profile[];
  /** Available tools for custom profile editing */
  availableTools: ToolMeta[];
  /** Loading state for initial fetch */
  loading: boolean;
  /** Whether profiles have been fetched at least once */
  initialized: boolean;

  // ─── Actions ──────────────────────────────────

  /** Fetch all profiles (system + custom). Idempotent if already loaded. */
  fetchProfiles: (force?: boolean) => Promise<void>;
  /** Fetch available tools for custom profile editing. */
  fetchTools: () => Promise<void>;
  /** Refresh profiles after CRUD (always re-fetches). */
  refresh: () => Promise<void>;
  /** Clear store (e.g. on logout). */
  clear: () => void;
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  profiles: [],
  availableTools: [],
  loading: false,
  initialized: false,

  fetchProfiles: async (force = false) => {
    const state = get();
    if (state.initialized && !force) return;
    if (state.loading) return; // prevent concurrent fetches

    set({ loading: true });
    try {
      const profiles = await api.fetchProfiles();
      set({ profiles, initialized: true });
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
      const profiles = await api.fetchProfiles();
      set({ profiles, initialized: true });
    } catch {
      /* ignore */
    }
  },

  clear: () => set({ profiles: [], availableTools: [], loading: false, initialized: false }),
}));
