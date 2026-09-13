/**
 * Profile Preferences — localStorage persistence for last-selected profile.
 */

const PROFILE_PREFIX = 'greenhouse-last-profile';

function profileKey(userId?: string): string {
  return userId ? `${PROFILE_PREFIX}-${userId}` : PROFILE_PREFIX;
}

/** Get the user's last-selected profile ID. Returns null if never set. */
export function getLastProfile(userId?: string): string | null {
  try {
    return localStorage.getItem(profileKey(userId));
  } catch {
    return null;
  }
}

/** Save the user's last-selected profile ID. */
export function setLastProfile(profileId: string, userId?: string): void {
  try {
    localStorage.setItem(profileKey(userId), profileId);
  } catch {
    /* ignore in restricted contexts */
  }
}

// ─── Model preference ────────────────────────────────────

const MODEL_KEY_PREFIX = 'greenhouse_last_model';

function modelKey(userId?: string): string {
  return userId ? `${MODEL_KEY_PREFIX}:${userId}` : MODEL_KEY_PREFIX;
}

/**
 * The model the user last picked. Deliberately per-user and global rather than
 * per-session: the model is a per-turn choice, so "what I usually run" is the
 * useful memory — reopening an old conversation preselects your habit, not
 * whatever that conversation happened to start on.
 */
export function getLastModel(userId?: string): string | null {
  try {
    return localStorage.getItem(modelKey(userId));
  } catch {
    return null;
  }
}

export function setLastModel(modelId: string, userId?: string): void {
  try {
    localStorage.setItem(modelKey(userId), modelId);
  } catch {
    /* ignore in restricted contexts */
  }
}
