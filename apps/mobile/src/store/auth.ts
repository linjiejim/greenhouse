/**
 * Auth store (Zustand) — current user + auth lifecycle.
 * Mirrors the web app's useAuthStore pattern.
 *
 * bootstrap() is also the station-switch path: it (re)hydrates the station
 * registry, loads the now-active station's tokens into the mirror and
 * revalidates — so callers just `switchTo(...)` then `bootstrap()`.
 */

import { create } from 'zustand';
import type { AuthenticatedUser } from '../shared/greenhouse-types';
import { hydrateTokens, getCachedUser, getAccessToken } from '../api/token-storage';
import { useStations } from './stations';
import { useTags } from './tags';
import * as authApi from '../api/auth';

/** Bumped per bootstrap so a superseded run (station switched again mid-flight)
 *  can't stomp the newer one's user/loading state. */
let bootGeneration = 0;

interface AuthState {
  user: AuthenticatedUser | null;
  /** true until the current hydrate + validate completes */
  loading: boolean;
  bootstrap: () => Promise<void>;
  login: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => void;
  setUser: (user: AuthenticatedUser | null) => void;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  loading: true,

  async bootstrap() {
    const gen = ++bootGeneration;
    set({ loading: true });
    await useStations.getState().hydrate();
    if (gen !== bootGeneration) return;
    await hydrateTokens(useStations.getState().activeId);
    if (gen !== bootGeneration) return;
    // Server-side caches (tags) belong to the previous station/user — drop them.
    useTags.getState().reset();
    // Optimistically show the cached user, then validate in the background.
    const cached = getCachedUser();
    if (cached) set({ user: cached });
    const validated = getAccessToken() ? await authApi.validateSession() : null;
    if (gen !== bootGeneration) return;
    set({ user: validated, loading: false });
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
