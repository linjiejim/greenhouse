/**
 * Profile Preferences — localStorage persistence for last-selected profile.
 */

const PROFILE_PREFIX = 'greenhouse-last-profile';
const GLOBAL_AGENT_PROFILE_PREFIX = 'greenhouse-global-agent-profile';

// One-time cleanup: remove deprecated tool-selection keys (ToolSelector removed)
try {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('greenhouse-active-tools')) keysToRemove.push(key);
  }
  keysToRemove.forEach((k) => localStorage.removeItem(k));
} catch {
  /* ignore in SSR / restricted contexts */
}

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
  localStorage.setItem(profileKey(userId), profileId);
}

// ─── Global Agent panel profile (independent of the Chat page) ─────────────
//
// The floating Global Agent picks its own profile, persisted separately from the
// Chat page so the two never clobber each other's last choice.

function globalAgentProfileKey(userId?: string): string {
  return userId ? `${GLOBAL_AGENT_PROFILE_PREFIX}-${userId}` : GLOBAL_AGENT_PROFILE_PREFIX;
}

/** Get the user's last Global Agent profile ID. Returns null if never set. */
export function getGlobalAgentProfile(userId?: string): string | null {
  try {
    return localStorage.getItem(globalAgentProfileKey(userId));
  } catch {
    return null;
  }
}

/** Save the user's last Global Agent profile ID. */
export function setGlobalAgentProfile(profileId: string, userId?: string): void {
  try {
    localStorage.setItem(globalAgentProfileKey(userId), profileId);
  } catch {
    /* ignore in restricted contexts */
  }
}
