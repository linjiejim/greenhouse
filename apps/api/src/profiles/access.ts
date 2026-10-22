import { getDb, type CustomProfileRow, type DatabaseProvider } from '@greenhouse/db';
import type { AuthUser } from '../auth/token.js';
import { DEFAULT_PROFILE_ID, normalizeProfileId, parseCustomProfileReference } from './profile.js';

type ProfileActor = Pick<AuthUser, 'id' | 'role'>;

export class ProfileAccessError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404,
  ) {
    super(message);
    this.name = 'ProfileAccessError';
  }
}

/**
 * The one visibility rule for custom Agents (v1.4): the owner and super always;
 * anyone else only while the Agent is shared with the team (`is_shared`).
 */
export function canUseCustomProfile(user: ProfileActor, row: Pick<CustomProfileRow, 'user_id' | 'is_shared'>) {
  return user.role === 'super' || row.user_id === user.id || row.is_shared;
}

/**
 * Resolve and authorize a custom profile reference. System profile IDs return
 * null; custom profiles must exist and be owned, shared, or requested by super.
 */
export async function assertCustomProfileAccess(
  user: ProfileActor,
  profileId: string,
): Promise<CustomProfileRow | null> {
  if (!profileId.startsWith('custom:')) return null;

  const reference = parseCustomProfileReference(profileId);
  if (!reference) throw new ProfileAccessError('Invalid custom profile ID', 400);

  const row = await getDb().customProfiles.getById(reference.profileId);
  if (!row) throw new ProfileAccessError('Custom profile not found', 404);
  if (!canUseCustomProfile(user, row)) {
    throw new ProfileAccessError('You do not have access to this custom profile', 403);
  }
  return row;
}

/**
 * Resolve visibility and return an immutable execution reference.
 *
 * An unpinned reference (`custom:7`) always pins the Agent's CURRENT version —
 * for the owner and for everyone the Agent is shared with alike; there is no
 * separate published channel any more. An already-pinned reference
 * (`custom:7@2`, carried by an existing session or Automation) keeps resolving
 * its own immutable version as long as the caller may still use the Agent.
 * This is the sole path for new sessions/tasks.
 */
export async function pinProfileIdForUser(
  user: ProfileActor,
  rawProfileId?: string | null,
  database: DatabaseProvider = getDb(),
): Promise<string> {
  const profileId = normalizeProfileId(rawProfileId) ?? DEFAULT_PROFILE_ID;
  if (!profileId.startsWith('custom:')) return profileId;

  const reference = parseCustomProfileReference(profileId);
  if (!reference) throw new ProfileAccessError('Invalid custom profile ID', 400);
  const row = await database.customProfiles.getById(reference.profileId);
  if (!row) throw new ProfileAccessError('Custom profile not found', 404);
  if (!canUseCustomProfile(user, row)) {
    throw new ProfileAccessError('You do not have access to this custom profile', 403);
  }

  const version = reference.version ?? row.current_version;
  const manifest = await database.customProfiles.getVersion(reference.profileId, version);
  if (!manifest) throw new ProfileAccessError('Custom profile version not found', 404);
  return `custom:${reference.profileId}@${version}`;
}
