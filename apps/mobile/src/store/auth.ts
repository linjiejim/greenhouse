/**
 * Auth store (Zustand) — current user + auth lifecycle.
 * Mirrors the web app's useAuthStore pattern.
 *
 * bootstrap() is also the station-switch path: it (re)hydrates the station
 * registry, loads the now-active station's tokens into the mirror and
 * revalidates. A change of the active station goes through
 * `switchStation(() => useStations.getState().switchTo(...))`, which raises
 * `loading` in the same tick as the change and then bootstraps — so nothing
 * gated on `loading` (the screens, the Bots socket and loads) runs against
 * the new station before its own session is loaded.
 *
 * Per-user server caches are NOT reset from here: each cache store clears
 * itself by subscribing to `useAuth` (user id) and `useStations` (activeId)
 * at module scope — see src/store/tags.ts and src/projects/store.ts. That
 * keeps this store free of feature imports (and import cycles), and covers
 * every transition: sign-out, signing in as someone else, station switch.
 */

import { create } from 'zustand';
import type { AuthenticatedUser } from '../shared/greenhouse-types';
import { hydrateTokens, getCachedUser, getAccessToken } from '../api/token-storage';
import { useStations } from './stations';
import * as authApi from '../api/auth';

/**
 * An auth transition reroutes the whole app (the root layout replaces the
 * stack with home or /login). A screen inside a sheet / modal that triggers
 * one dismisses its host first and waits this long, so the reroute never
 * happens under a presented sheet.
 */
export const AFTER_DISMISS_MS = 380;

/** Bumped per bootstrap so a superseded run (station switched again mid-flight)
 *  can't stomp the newer one's user/loading state. */
let bootGeneration = 0;

interface AuthState {
  user: AuthenticatedUser | null;
  /** true until the current hydrate + validate completes */
  loading: boolean;
  bootstrap: () => Promise<void>;
  /**
   * Change the active station (`change` is a useStations mutation: switchTo /
   * add / remove) and sign in to it. `loading` goes up synchronously, before
   * `change` repoints the registry, so the switch never renders with
   * `loading: false` against the new station; bootstrap() then loads its
   * tokens, revalidates and lowers it.
   */
  switchStation: (change: () => Promise<unknown>) => Promise<void>;
  login: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => void;
  setUser: (user: AuthenticatedUser | null) => void;
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  loading: true,

  async bootstrap() {
    const gen = ++bootGeneration;
    set({ loading: true });
    await useStations.getState().hydrate();
    if (gen !== bootGeneration) return;
    await hydrateTokens(useStations.getState().activeId);
    if (gen !== bootGeneration) return;
    // Optimistically show the cached user, then validate in the background.
    const cached = getCachedUser();
    if (cached) set({ user: cached });
    const validated = getAccessToken() ? await authApi.validateSession() : null;
    if (gen !== bootGeneration) return;
    set({ user: validated, loading: false });
  },

  async switchStation(change) {
    // Supersede an in-flight bootstrap first: it must not lower `loading`
    // between this change and the bootstrap that follows it.
    bootGeneration += 1;
    set({ loading: true });
    try {
      await change();
    } finally {
      await get().bootstrap();
    }
  },

  async login(email, password) {
    const res = await authApi.login(email, password);
    if (res.ok && res.user) set({ user: res.user });
    return { ok: res.ok, error: res.error };
  },

  logout() {
    authApi.logout();
    set({ user: null });
  },

  setUser(user) {
    set({ user });
  },
}));
