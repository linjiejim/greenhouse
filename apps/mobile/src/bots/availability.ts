/**
 * Who sees Bots, and where (spec §2.2 gate table). Two gates, because the
 * server has two (06 C6):
 * - the conversation surfaces (drawer section, threads, capsule, ☰ badge, WS)
 *   need the `bots` feature on top of an internal account;
 * - Bot identity management (Settings → My Bots) needs an internal account only.
 * Both stay closed on Android in v1 (§2.9) and after the server said no for
 * this app session (`useBots.error`: 403 → `forbidden`, older server → `missing`).
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

/** The conversation surfaces: iOS, internal, `features.bots === true` (missing = off), not refused. */
function botsEnabled(user: AuthenticatedUser | null, error: BotsState['error']): boolean {
  return (
    BOTS_PLATFORM_READY &&
    isInternal(user) &&
    user?.features?.bots === true &&
    error !== 'forbidden' &&
    error !== 'missing'
  );
}

/** Bot identity management: iOS, internal, and a server that has Bots at all. */
function identityEnabled(user: AuthenticatedUser | null, error: BotsState['error']): boolean {
  return BOTS_PLATFORM_READY && isInternal(user) && error !== 'missing';
}

export function useBotsEnabled(): boolean {
  const user = useAuth((s) => s.user);
  const error = useBots((s) => s.error);
  return botsEnabled(user, error);
}

export function useBotIdentityEnabled(): boolean {
  const user = useAuth((s) => s.user);
  const error = useBots((s) => s.error);
  return identityEnabled(user, error);
}

/** Non-hook snapshot of `useBotsEnabled()` (cold-start restore, deep links). */
export function botsEnabledNow(): boolean {
  return botsEnabled(useAuth.getState().user, useBots.getState().error);
}
