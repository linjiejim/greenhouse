/**
 * Auth Store (Zustand) — global authentication state.
 *
 * Replaces scattered useState/useCallback in App component
 * for auth state, user info, and sign-out.
 */

import { create } from 'zustand';
import type { AuthenticatedUser } from '../lib/auth';

export type AuthState = 'checking' | 'needs-login' | 'authenticated';

interface AuthStore {
  authState: AuthState;
  currentUser: AuthenticatedUser | null;

  setAuthState: (state: AuthState) => void;
  setCurrentUser: (user: AuthenticatedUser | null) => void;
  login: (user: AuthenticatedUser) => void;
  logout: () => void;
  updateUser: (updates: Partial<AuthenticatedUser>) => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  authState: 'checking',
  currentUser: null,

  setAuthState: (authState) => set({ authState }),
  setCurrentUser: (currentUser) => set({ currentUser }),

  login: (user) =>
    set({
      currentUser: user,
      authState: 'authenticated',
    }),

  logout: () =>
    set({
      currentUser: null,
      authState: 'needs-login',
    }),

  updateUser: (updates) =>
    set((state) => ({
      currentUser: state.currentUser ? { ...state.currentUser, ...updates } : null,
    })),
}));
