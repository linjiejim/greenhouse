/** Shared authorization path for user-owned conversation creation. */

import { getDb } from '@greenhouse/db';
import type { SessionRow } from '@greenhouse/types/session';

import type { AuthUser } from './auth/token.js';
import { resolveProfileAsync } from './profile.js';
import { pinProfileIdForUser, ProfileAccessError } from './profile-access.js';

type SessionActor = Pick<AuthUser, 'id' | 'role'>;

export class SessionCreationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404,
  ) {
    super(message);
    this.name = 'SessionCreationError';
  }
}

/**
 * Create an ordinary conversation after applying the same profile pinning and
 * visibility checks used by POST /api/sessions.
 *
 * Mission direct-launch also consumes this helper so it cannot mint a session
 * with a profile that ordinary Chat would reject.
 */
export async function createOwnedSession(
  actor: SessionActor,
  input: { title?: string; profileId?: string },
): Promise<SessionRow> {
  let profileId: string;
  try {
    profileId = await pinProfileIdForUser(actor, input.profileId);
  } catch (err) {
    if (err instanceof ProfileAccessError) throw new SessionCreationError(err.message, err.status);
    throw err;
  }

  let profile;
  try {
    profile = await resolveProfileAsync(profileId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SessionCreationError(`Invalid profile: ${message}`, 400);
  }
  if (profile.access.level === 'hidden') {
    throw new SessionCreationError(`Profile "${profileId}" cannot be used for cloud sessions`, 403);
  }

  return getDb().sessions.create(input.title, profileId, actor.id);
}
