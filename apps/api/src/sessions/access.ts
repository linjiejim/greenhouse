/**
 * Session access policy shared by HTTP routes.
 *
 * Sharing grants read access only. Mutating a session (including continuing a
 * chat) remains limited to the owner or a super user. Bots conversations are
 * the exception both ways: owner-only.
 */

import { getDb } from '@greenhouse/db';
import type { AuthUser } from '../auth/token.js';
import { BOTS_SESSION_CHANNEL, type SessionRow } from '@greenhouse/types/session';

/**
 * Check whether a user may read/list a session.
 *
 * Bots conversations are owner-only for reading too, super included: they carry
 * page text from the owner's signed-in browser, shell output and Bot-private
 * context, and they are never shared.
 */
export async function canAccessSession(user: AuthUser, session: SessionRow): Promise<boolean> {
  if (session.channel === BOTS_SESSION_CHANNEL) return session.user_id === user.id;
  if (user.role === 'super') return true;
  if (session.user_id === user.id) return true;

  const sharedIds = await getDb().sessionShares.getSharedSessionIds(user.id);
  return sharedIds.includes(session.id);
}

/**
 * Check whether a user may mutate or continue a session.
 *
 * Bots conversations are owner-only, super included: continuing one drives the
 * owner's Bots, their computer and their vault, which no other account may do
 * (docs/specs/20261005-personal-assistant-bots.md §10).
 */
export function canWriteSession(user: AuthUser, session: SessionRow): boolean {
  if (session.channel === BOTS_SESSION_CHANNEL) return session.user_id === user.id;
  if (user.role === 'super') return true;
  return session.user_id === user.id;
}
