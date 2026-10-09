/**
 * Who sees Bots, and where (spec §2.2 gate table). Two gates, because the
 * server has two (06 C6):
 * - the conversation surfaces (drawer section, threads, ☰ badge, WS)
 *   need the `bots` feature on top of an internal account;
 * - Bot identity management (Settings → My Bots) needs an internal account only.
 * Both stay closed on Android in v1 (§2.9), after the server said no for this
 * app session (`useBots.error`: 403 → `forbidden`, older server → `missing`),
 * and while auth is loading (`useAuth.loading`: startup, and a station switch
 * — where `user` is still the previous station's account until bootstrap()
 * validates the new one), so the socket and the Bots loads never start
 * against a station before its own session is in.
 */

import { Platform } from 'react-native';
import type { AuthenticatedUser } from '../shared/greenhouse-types';
import { useAuth } from '../store/auth';
import { useBots, type BotsState } from './store';

/** v1 ships on iOS only; Android gets the views later (all behaviour already lives in shared hooks). */
export const BOTS_PLATFORM_READY: boolean = Platform.OS === 'ios';

/** A member (`team`) or an admin (`super`) — the only accounts the Bots routes and the WS accept. */
export function isInternal(user: { role?: string } | null | undefined): boolean {
  return user?.role === 'super' || user?.role === 'team';
}

/** The conversation surfaces: iOS, settled auth, internal, `features.bots === true` (missing = off), not refused. */
function botsEnabled(user: AuthenticatedUser | null, loading: boolean, error: BotsState['error']): boolean {
  return (
    BOTS_PLATFORM_READY &&
    !loading &&
    isInternal(user) &&
    user?.features?.bots === true &&
    error !== 'forbidden' &&
    error !== 'missing'
  );
}

/** Bot identity management: iOS, settled auth, internal, and a server that has Bots at all. */
function identityEnabled(user: AuthenticatedUser | null, loading: boolean, error: BotsState['error']): boolean {
  return BOTS_PLATFORM_READY && !loading && isInternal(user) && error !== 'missing';
}

export function useBotsEnabled(): boolean {
  const user = useAuth((s) => s.user);
  const loading = useAuth((s) => s.loading);
  const error = useBots((s) => s.error);
  return botsEnabled(user, loading, error);
}

export function useBotIdentityEnabled(): boolean {
  const user = useAuth((s) => s.user);
  const loading = useAuth((s) => s.loading);
  const error = useBots((s) => s.error);
  return identityEnabled(user, loading, error);
}

/** Non-hook snapshot of `useBotsEnabled()` (cold-start restore, deep links). */
export function botsEnabledNow(): boolean {
  const { user, loading } = useAuth.getState();
  return botsEnabled(user, loading, useBots.getState().error);
}
