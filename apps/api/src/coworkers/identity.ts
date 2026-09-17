import { getDb, type DatabaseProvider } from '@greenhouse/db';
import { pinProfileIdForUser } from '../profiles/access.js';
import { parseCustomProfileReference, resolveProfileAsync } from '../profiles/profile.js';
import type { AuthUser } from '../auth/token.js';

/** A stable instance survives profile-version edits. Shared assets share identity, never authority. */
export async function resolveCoworker(
  actor: Pick<AuthUser, 'id' | 'role'>,
  rawProfileId: string,
  db: DatabaseProvider = getDb(),
) {
  const profileId = await pinProfileIdForUser(actor, rawProfileId, db);
  const profile = await resolveProfileAsync(profileId, db);
  if (profile.access.level === 'hidden') throw new Error('This Agent is unavailable for conversation');
  const custom = parseCustomProfileReference(profileId);
  const asset = custom ? await db.customProfiles.getById(custom.profileId) : null;
  const instance = await db.coworkers.ensure({
    profile_key: custom ? `custom:${custom.profileId}` : profileId,
    owner_user_id: asset?.user_id ?? actor.id,
    name: profile.name,
  });
  return { instance, profile, profileId };
}
