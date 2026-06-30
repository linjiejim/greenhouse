/**
 * Profiles API — base profiles, custom profiles, usage summary.
 */

import type { Profile, ProfileDetail, UsageSummary } from '@greenhouse/types/api';
import { rpc } from './client';

export async function fetchProfiles(): Promise<Profile[]> {
  try {
    const res = await rpc.api.profiles.$get({ query: {} });
    if (!res.ok) return [];
    return (await res.json()).profiles ?? [];
  } catch {
    return [];
  }
}

export async function fetchProfileDetail(id: string): Promise<ProfileDetail> {
  const res = await rpc.api.profiles[':id'].$get({ param: { id } });
  if (!res.ok) throw new Error(`Failed to fetch profile: ${res.status}`);
  return res.json();
}

export async function fetchUsageSummary(since?: string): Promise<UsageSummary> {
  const res = await rpc.api.profiles.usage.summary.$get({
    query: since ? { since } : {},
  });
  if (!res.ok) throw new Error(`Failed to fetch usage summary: ${res.status}`);
  return res.json();
}

// ─── Custom Profiles API ───────────────────────────────

export interface CustomProfileInput {
  name: string;
  description?: string;
  base_profile_id: string;
  tools: string[];
  system_prompt: string;
  capabilities?: Array<{ icon: string; label: string; prompt: string }>;
  max_steps?: number;
  is_shared?: boolean;
  avatar?: { color?: string; accessories?: string[]; leafStyle?: string };
}

export async function fetchCustomProfiles(): Promise<Profile[]> {
  try {
    const res = await rpc.api.profiles.custom.$get();
    if (!res.ok) return [];
    return (await res.json()).profiles ?? [];
  } catch {
    return [];
  }
}

export async function createCustomProfile(input: CustomProfileInput): Promise<Profile> {
  const res = await rpc.api.profiles.custom.$post({ json: input });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(('error' in data && data.error) || 'Failed to create profile');
  }
  return res.json();
}

export async function updateCustomProfile(id: number, input: Partial<CustomProfileInput>): Promise<Profile> {
  // Non-literal arg: hc only types `json` for validator-backed routes (none yet);
  // the indirection passes the body while keeping param/response typing.
  const args = { param: { id: String(id) }, json: input };
  const res = await rpc.api.profiles.custom[':id'].$put(args);
  if (!res.ok) {
    const data = await res.json();
    throw new Error(('error' in data && data.error) || 'Failed to update profile');
  }
  return res.json();
}

export async function deleteCustomProfile(id: number): Promise<void> {
  const res = await rpc.api.profiles.custom[':id'].$delete({ param: { id: String(id) } });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(('error' in data && data.error) || 'Failed to delete profile');
  }
}

export async function forkProfile(sourceProfileId: string, name?: string): Promise<Profile> {
  const res = await rpc.api.profiles.custom.fork.$post({
    json: { source_profile_id: sourceProfileId, ...(name ? { name } : {}) },
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(('error' in data && data.error) || 'Failed to fork profile');
  }
  return res.json();
}
