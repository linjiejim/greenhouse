/**
 * The agents a member may chat with or run automations as (`GET /api/profiles`): the built-in
 * assistant (Sprouty) first, then the member's own and team-shared custom agents (`custom:<id>`).
 * Answers an `ApiResult`, never throws.
 */

import { get, type ApiResult } from './client';

export interface AgentProfile {
  id: string;
  name: string;
  name_i18n?: Record<string, string> | null;
  description?: string | null;
  is_custom?: boolean;
}

export const listProfiles = async (): Promise<ApiResult<AgentProfile[]>> => {
  const result = await get<{ profiles: AgentProfile[] }>('/api/profiles');
  return result.ok ? { ok: true, data: result.data.profiles ?? [] } : result;
};

/** A profile's name in the app's language (`name_i18n`, else the name). */
export function profileName(profile: Pick<AgentProfile, 'name' | 'name_i18n'>, lang: string): string {
  return profile.name_i18n?.[lang] || profile.name;
}

/** The profile a pinned reference (`custom:<id>@<version>`) names, if listed. */
export function findProfile(profiles: readonly AgentProfile[], ref: string | null | undefined): AgentProfile | null {
  const id = ref?.replace(/@\d+$/, '');
  return (id && profiles.find((profile) => profile.id === id)) || null;
}
