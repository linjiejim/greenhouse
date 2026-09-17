/**
 * Session access policy shared by HTTP routes.
 *
 * Sharing grants read access only. Mutating a session (including continuing a
 * chat) remains limited to the owner or a super user.
 */

import { safeJsonParse } from '@greenhouse/utils/json';
import { getDb } from '@greenhouse/db';
import type { AuthUser } from '../auth/token.js';
import type { SessionRow } from '@greenhouse/types/session';

/** Check whether a user may read/list a session. */
export async function canAccessSession(user: AuthUser, session: SessionRow): Promise<boolean> {
  if (user.role === 'super') return true;
  if (session.user_id === user.id) return true;

  const sharedIds = await getDb().sessionShares.getSharedSessionIds(user.id);
  return sharedIds.includes(session.id);
}

/** Check whether a user may mutate or continue a session. */
export function canWriteSession(user: AuthUser, session: SessionRow): boolean {
  const metadata = safeJsonParse(session.metadata, {}) as Record<string, unknown>;
  if (session.channel === 'subagent' && metadata.dialogue_id) return false;
  if (user.role === 'super') return true;
  return session.user_id === user.id;
}
