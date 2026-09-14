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
  if (user.role !== 'super' && row.user_id !== user.id) {
    if (!row.is_shared || (row.lifecycle_status !== 'pilot' && row.lifecycle_status !== 'verified')) {
      throw new ProfileAccessError('You do not have access to this custom profile', 403);
    }
    if (!row.published_version) throw new ProfileAccessError('Agent has no published version', 403);
    if (reference.version !== undefined && reference.version !== row.published_version) {
      throw new ProfileAccessError('Only the published Agent version is available', 403);
    }
  }
  return row;
}

/**
 * Resolve visibility and return an immutable execution reference.
 *
 * Owners/super pin the current draft; other users can only pin the reviewed
 * published version of a pilot/verified Agent. This is the sole path for new
 * sessions/tasks/evals, so sharing never leaks an owner's newer draft.
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

  if (['rejected', 'suspended', 'deprecated', 'archived'].includes(row.lifecycle_status)) {
    throw new ProfileAccessError(`Agent is not executable (${row.lifecycle_status})`, 403);
  }

  const ownsAsset = user.role === 'super' || row.user_id === user.id;
  let version: number;
  if (ownsAsset) {
    version = reference.version ?? row.current_version;
  } else {
    if (!row.is_shared || (row.lifecycle_status !== 'pilot' && row.lifecycle_status !== 'verified')) {
      throw new ProfileAccessError('You do not have access to this custom profile', 403);
    }
    if (!row.published_version) throw new ProfileAccessError('Agent has no published version', 403);
    if (reference.version !== undefined && reference.version !== row.published_version) {
      throw new ProfileAccessError('Only the published Agent version is available', 403);
    }
    version = row.published_version;
  }

  const manifest = await database.customProfiles.getVersion(reference.profileId, version);
  if (!manifest) throw new ProfileAccessError('Custom profile version not found', 404);
  return `custom:${reference.profileId}@${version}`;
}
