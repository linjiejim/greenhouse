/**
 * The agents a new conversation may start with (`GET /api/profiles`): Sprouty and any custom
 * agents of mine or shared with the team. The composer's + menu offers the choice only when
 * there is more than one (most stations have Sprouty alone); an existing conversation keeps the
 * agent it started with.
 */

import { useMemo } from 'react';
import { listProfiles, profileName } from '../api/profiles';
import { useResource } from '../data/use-resource';
import { usePrefs } from '../store/prefs';

export interface ChatAgent {
  id: string;
  name: string;
}

export function useChatAgents(): ChatAgent[] {
  const lang = usePrefs((s) => s.lang);
  const profiles = useResource(listProfiles);
  return useMemo(
    () => (profiles.data ?? []).map((profile) => ({ id: profile.id, name: profileName(profile, lang) })),
    [profiles.data, lang],
  );
}
