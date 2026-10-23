/**
 * Which profiles an automation may run as, for the Automations form: the
 * system profiles, plus run profiles (custom profiles) the member owns or that
 * are shared with the team. The server pins a picked run profile to its current
 * version (`custom:<id>@<v>`) and re-checks the owner's access at save and on
 * every run, so this list is a convenience, not the rule.
 */

import type { Profile } from '@greenhouse/types/api';

export interface AutomationProfileChoices {
  system: Profile[];
  runProfiles: Profile[];
}

export function automationProfileChoices(
  profiles: readonly Profile[],
  userId: string | undefined,
): AutomationProfileChoices {
  return {
    system: profiles.filter((profile) => !profile.is_custom),
    runProfiles: profiles.filter(
      (profile) => profile.is_custom && (profile.user_id === userId || profile.is_shared === true),
    ),
  };
}

/** `custom:5@3` → `custom:5`; any other id unchanged. */
export function unpinnedProfileId(id: string): string {
  return id.startsWith('custom:') ? id.replace(/@\d+$/, '') : id;
}

/** The version a stored `custom:<id>@<v>` is pinned to, or null. */
export function pinnedProfileVersion(id: string): number | null {
  const match = /^custom:[^@]+@(\d+)$/.exec(id);
  return match ? Number(match[1]) : null;
}
