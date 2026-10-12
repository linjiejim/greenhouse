/**
 * Session access policy shared by HTTP routes.
 *
 * Sharing grants read access only. Mutating a session (including continuing a
 * chat) remains limited to the owner — or a super user where the deployment
 * lets super read chats (`SUPER_READS_CHATS`, off by default since 2026-10-12).
 * Bots conversations are the exception both ways: owner-only, and a room
 * (several people) is readable and writable by its participants.
 */

import { getDb } from '@greenhouse/db';
import type { AuthUser } from '../auth/token.js';
import { BOTS_SESSION_CHANNEL, isOwnerOnlySession, type SessionRow } from '@greenhouse/types/session';

/**
 * Check whether a user may read/list a session.
 *
 * Bots conversations are owner-only for reading too, super included: they carry
 * page text from the owner's signed-in browser, shell output and Bot-private
 * context, and they are never shared.
 */
export async function canAccessSession(user: AuthUser, session: SessionRow): Promise<boolean> {
  if (isOwnerOnlySession(session)) return session.user_id === user.id || (await isRoomParticipant(user, session));
  if (superSeesAllChats(user)) return true;
  if (session.user_id === user.id) return true;

  const sharedIds = await getDb().sessionShares.getSharedSessionIds(user.id);
  return sharedIds.includes(session.id);
}

/**
 * Super reads (and continues) other members' ordinary chats only where the deployment says so
 * (spec 20261011-agent-first-class D46): `SUPER_READS_CHATS=true` restores the old rule for
 * deployments that need it for compliance or support. Agent conversations never: they are
 * owner-only (and a room participants-only) either way.
 */
export function superReadsChats(): boolean {
  return /^(1|true|yes)$/i.test(process.env.SUPER_READS_CHATS?.trim() ?? '');
}

export function superSeesAllChats(user: { role: string }): boolean {
  return user.role === 'super' && superReadsChats();
}

/** A room (several people, P5) this member takes part in. */
async function isRoomParticipant(user: AuthUser, session: SessionRow): Promise<boolean> {
  if (session.channel !== BOTS_SESSION_CHANNEL) return false;
  try {
    return await getDb().bots.isParticipant(session.id, user.id);
  } catch {
    return false; // an access check that cannot be answered denies
  }
}

/**
 * May this member post into the session and follow its live run? The owner — or, for a room, any
 * of its people (each turn there runs as whoever asked). Administering the session (rename,
 * delete, share, tags) stays `canWriteSession`.
 */
export async function canPostToSession(user: AuthUser, session: SessionRow): Promise<boolean> {
  if (canWriteSession(user, session)) return true;
  return isOwnerOnlySession(session) && (await isRoomParticipant(user, session));
}

/**
 * Check whether a user may mutate or continue a session.
 *
 * Bots conversations are owner-only, super included: continuing one drives the
 * owner's Bots, their computer and their vault, which no other account may do
 * (docs/specs/20261005-personal-assistant-bots.md §10).
 */
export function canWriteSession(user: AuthUser, session: SessionRow): boolean {
  if (isOwnerOnlySession(session)) return session.user_id === user.id;
  if (superSeesAllChats(user)) return true;
  return session.user_id === user.id;
}
