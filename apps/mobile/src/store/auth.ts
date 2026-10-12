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
import { checkAborted, ConnectionTimeoutError, withConnectionDeadline } from '../api/connection-deadline';

/**
 * An auth transition reroutes the whole app (the root layout replaces the
 * stack with home or /login). A screen inside a sheet / modal that triggers
 * one dismisses its host first and waits this long, so the reroute never
 * happens under a presented sheet.
 */
export const AFTER_DISMISS_MS = 380;

/** Keep the visible startup below 10s, including native mount/redirect time.
 * Simulator recordings showed a full 10s network budget left the cover visible for ~11s.
 */
export const STARTUP_CONNECTION_TIMEOUT_MS = 8_500;

/** Bumped per bootstrap so a superseded run (station switched again mid-flight)
 *  can't stomp the newer one's user/loading state. */
let bootGeneration = 0;
let bootController: AbortController | undefined;

interface AuthState {
  user: AuthenticatedUser | null;
  /** true until the current hydrate + validate completes */
  loading: boolean;
  startupError: 'timeout' | 'connection' | null;
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

export const useAuth = create<AuthState>((set) => {
  async function initialize(change?: () => Promise<unknown>): Promise<void> {
    const gen = ++bootGeneration;
    bootController?.abort();
    const controller = new AbortController();
    bootController = controller;
    set({ loading: true, user: null, startupError: null });
    try {
      const user = await withConnectionDeadline(async (signal) => {
        const current = () => {
          checkAborted(signal);
          if (gen !== bootGeneration) throw new Error('Superseded startup');
        };
        if (change) await change();
        current();
        await useStations.getState().hydrate(signal);
        current();
        await hydrateTokens(useStations.getState().activeId, signal);
        current();
        const cached = getCachedUser();
        if (cached) set({ user: cached });
        return getAccessToken() ? authApi.validateSession(signal) : null;
      }, controller, STARTUP_CONNECTION_TIMEOUT_MS);
      if (gen === bootGeneration) set({ user, loading: false });
    } catch (error) {
      if (gen === bootGeneration) {
        set({
          user: null,
          loading: false,
          startupError: error instanceof ConnectionTimeoutError ? 'timeout' : 'connection',
        });
      }
    }
  }

  return {
    user: null,
    loading: true,
    startupError: null,

    bootstrap: () => initialize(),
    switchStation: (change) => initialize(change),

    async login(email, password) {
      const res = await authApi.login(email, password);
      if (res.ok && res.user) {
        bootGeneration += 1;
        set({ user: res.user, loading: false, startupError: null });
      }
      return { ok: res.ok, error: res.error };
    },

    logout() {
      bootGeneration += 1;
      bootController?.abort();
      authApi.logout();
      set({ user: null, loading: false, startupError: null });
    },

    setUser(user) {
      set({ user });
    },
  };
});
