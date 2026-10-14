/**
 * Auth store (Zustand) — the signed-in member (`Me`, API v2) and the auth lifecycle.
 *
 * bootstrap() is also the station-switch path: it (re)hydrates the station registry, loads the
 * now-active station's tokens into the mirror, reads the station's public facts
 * (`/api/bootstrap`: its name, logo and `api_version`) and revalidates the session. A change of
 * the active station goes through `switchStation(() => useStations.getState().switchTo(...))`,
 * which raises `loading` in the same tick as the change and then bootstraps — so nothing gated
 * on `loading` (the screens, the realtime socket, loads) runs against the new station before its
 * own session is loaded.
 *
 * A station that speaks another API (`mismatch`, ../api/compat.ts) is not used: the root layout
 * shows why ("update the app" / the server is still v1) with the way to another station, never
 * a white screen.
 *
 * Per-member caches are NOT reset from here: each cache store clears itself by subscribing to
 * `useAuth` (member id) and `useStations` (activeId) at module scope. That keeps this store free
 * of feature imports (and import cycles), and covers every transition: sign-out, signing in as
 * someone else, station switch.
 */

import { create } from 'zustand';
import type { Bootstrap, Me } from '../shared/contract';
import { hydrateTokens, getCachedUser, getAccessToken } from '../api/token-storage';
import { getApiBase, useStations } from './stations';
import * as authApi from '../api/auth';
import { apiMismatch, parseBootstrap, type ApiMismatch } from '../api/compat';
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
  user: Me | null;
  /** true until the current hydrate + validate completes */
  loading: boolean;
  startupError: 'timeout' | 'connection' | null;
  /** The active station's public facts, once read (its name and logo on the sign-in page). */
  station: Bootstrap | null;
  /** The active station speaks another API than this app (then nothing else is loaded). */
  mismatch: ApiMismatch | null;
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
  setUser: (user: Me | null) => void;
}

/** `/api/bootstrap` of the active station: its body (whatever it is), or undefined when unreachable. */
async function readBootstrap(signal: AbortSignal): Promise<unknown> {
  try {
    const res = await fetch(`${getApiBase()}/api/bootstrap`, { signal });
    if (!res.ok) return undefined;
    return (await res.json()) as unknown;
  } catch {
    return undefined;
  }
}

export const useAuth = create<AuthState>((set) => {
  async function initialize(change?: () => Promise<unknown>): Promise<void> {
    const gen = ++bootGeneration;
    bootController?.abort();
    const controller = new AbortController();
    bootController = controller;
    set({ loading: true, user: null, startupError: null, mismatch: null });
    try {
      const outcome = await withConnectionDeadline(
        async (signal) => {
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
          // The station's facts and the session are read side by side; a station of another
          // API is not signed in to at all.
          const [boot, user] = await Promise.all([
            readBootstrap(signal),
            getAccessToken() ? authApi.validateSession(signal).catch(() => undefined) : Promise.resolve(null),
          ]);
          current();
          const mismatch = apiMismatch(boot);
          if (mismatch) return { user: null, station: null, mismatch };
          // An outage while validating: keep the cached member, the screens retry on their own.
          if (user === undefined && boot === undefined) throw new Error('Station unreachable');
          return { user: user === undefined ? cached : user, station: parseBootstrap(boot), mismatch: null };
        },
        controller,
        STARTUP_CONNECTION_TIMEOUT_MS,
      );
      if (gen === bootGeneration) set({ ...outcome, loading: false });
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
    station: null,
    mismatch: null,

    bootstrap: () => initialize(),
    switchStation: (change) => initialize(change),

    async login(email, password) {
      const res = await authApi.login(email, password);
      if (res.ok) {
        bootGeneration += 1;
        set({ user: res.user, loading: false, startupError: null });
        return { ok: true };
      }
      return { ok: false, error: res.error };
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
