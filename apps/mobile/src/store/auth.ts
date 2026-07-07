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
import * as authApi from '../api/auth';

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
    set({ loading: true });
    await useStations.getState().hydrate();
    await hydrateTokens(useStations.getState().activeId);
    // Optimistically show the cached user, then validate in the background.
    const cached = getCachedUser();
    if (cached) set({ user: cached });
    const validated = getAccessToken() ? await authApi.validateSession() : null;
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
