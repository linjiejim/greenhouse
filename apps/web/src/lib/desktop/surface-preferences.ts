/** User-scoped, device-local configuration for Desktop satellite surfaces. */

const STORAGE_PREFIX = 'greenhouse:desktop-surfaces:v1:';
const CHANGE_EVENT = 'greenhouse:desktop-surfaces-changed';
const MAX_PROFILE_SHORTCUTS = 8;

export interface DesktopSurfacePreferences {
  version: 1;
  selectionProfileIds: string[];
  quickProfileIds: string[];
}

const EMPTY_PREFERENCES: DesktopSurfacePreferences = {
  version: 1,
  selectionProfileIds: [],
  quickProfileIds: [],
};

function storageKey(userId?: string | null): string {
  return `${STORAGE_PREFIX}${userId || '__anonymous__'}`;
}

function validIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))].slice(
    0,
    MAX_PROFILE_SHORTCUTS,
  );
}

export function parseDesktopSurfacePreferences(raw: string | null): DesktopSurfacePreferences {
  if (!raw) return { ...EMPTY_PREFERENCES };
  try {
    const value = JSON.parse(raw) as Partial<DesktopSurfacePreferences>;
    return {
      version: 1,
      selectionProfileIds: validIds(value.selectionProfileIds),
      quickProfileIds: validIds(value.quickProfileIds),
    };
  } catch {
    return { ...EMPTY_PREFERENCES };
  }
}

export function getDesktopSurfacePreferences(userId?: string | null): DesktopSurfacePreferences {
  try {
    return parseDesktopSurfacePreferences(localStorage.getItem(storageKey(userId)));
  } catch {
    return { ...EMPTY_PREFERENCES };
  }
}

export function setDesktopSurfacePreferences(
  userId: string | null | undefined,
  preferences: DesktopSurfacePreferences,
): DesktopSurfacePreferences {
  const normalized: DesktopSurfacePreferences = {
    version: 1,
    selectionProfileIds: validIds(preferences.selectionProfileIds),
    quickProfileIds: validIds(preferences.quickProfileIds),
  };
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(normalized));
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { userId: userId || null } }));
  } catch {
    /* private browsing / storage denied: keep the current in-memory UI usable */
  }
  return normalized;
}

export function subscribeDesktopSurfacePreferences(
  userId: string | null | undefined,
  listener: (preferences: DesktopSurfacePreferences) => void,
): () => void {
  const key = storageKey(userId);
  const notify = () => listener(getDesktopSurfacePreferences(userId));
  const onStorage = (event: StorageEvent) => {
    if (event.key === key) notify();
  };
  const onLocalChange = (event: Event) => {
    const detail = (event as CustomEvent<{ userId: string | null }>).detail;
    if ((detail?.userId || null) === (userId || null)) notify();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(CHANGE_EVENT, onLocalChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CHANGE_EVENT, onLocalChange);
  };
}

export interface SurfaceProfile {
  id: string;
  name: string;
}

export function resolveSurfaceProfiles<T extends SurfaceProfile>(
  profiles: T[],
  configuredIds: string[],
  preferredProfileId?: string | null,
): T[] {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const configured = configuredIds.flatMap((id) => {
    const profile = byId.get(id);
    return profile ? [profile] : [];
  });
  if (configured.length > 0) return configured;

  const preferred = preferredProfileId ? byId.get(preferredProfileId) : undefined;
  if (preferred) return [preferred];
  const team = byId.get('team');
  if (team) return [team];
  return profiles.slice(0, 1);
}

/** A single configured Profile is a decision, not a menu worth showing. */
export function resolveDirectSurfaceProfile<T extends SurfaceProfile>(profiles: readonly T[]): T | undefined {
  return profiles.length === 1 ? profiles[0] : undefined;
}
