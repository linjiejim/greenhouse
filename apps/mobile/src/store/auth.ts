/**
 * Auth store (Zustand) — current user + auth lifecycle.
 * Mirrors the web app's useAuthStore pattern.
 */

import { create } from 'zustand';
import type { AuthenticatedUser } from '../shared/greenhouse-types';
import { hydrateTokens, getCachedUser } from '../api/token-storage';
import * as authApi from '../api/auth';

interface AuthState {
  user: AuthenticatedUser | null;
  /** true until the initial hydrate + validate completes */
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
    await hydrateTokens();
    // Optimistically show the cached user, then validate in the background.
    const cached = getCachedUser();
    if (cached) set({ user: cached });
    const validated = await authApi.validateSession();
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
