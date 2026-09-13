/**
 * Profiles API — base profiles, custom profiles, usage summary.
 */

import type { Profile, ProfileAvatar, ProfileDetail, UsageSummary } from '@greenhouse/types/api';
import { rpc } from './client';

export class ProfilesRequestError extends Error {
  constructor(public readonly status: number) {
    super(`Failed to fetch profiles: ${status}`);
  }
}

/** A model the user may pick for a turn — served alongside the profile list. */
export interface ChatModel {
  id: string;
  name: string;
}

/**
 * Profiles + the models a user may switch between, from one request.
 *
 * Most callers only want the profiles, so `fetchProfiles` keeps its shape and
 * this fuller variant serves the one consumer (the chat store) that also
 * renders the model picker.
 */
export async function fetchProfilesAndModels(): Promise<{ profiles: Profile[]; models: ChatModel[] }> {
  const res = await rpc.api.profiles.$get();
  if (!res.ok) throw new ProfilesRequestError(res.status);
  const data = await res.json();
  return { profiles: data.profiles ?? [], models: 'models' in data ? (data.models ?? []) : [] };
}

export async function fetchProfilesStrict(): Promise<Profile[]> {
  return (await fetchProfilesAndModels()).profiles;
}

export async function fetchProfiles(): Promise<Profile[]> {
  try {
    return await fetchProfilesStrict();
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
  /** Registry model id this agent runs on. */
  model_id?: string;
  tools: string[];
  system_prompt: string;
  capabilities?: Array<{ icon: string; label: string; prompt: string }>;
  max_steps?: number;
  is_shared?: boolean;
  avatar?: ProfileAvatar;
  purpose?: string;
  audience?: string;
  risk_level?: 'low' | 'medium' | 'high';
  budget_policy?: Record<string, unknown>;
  eval_refs?: unknown[];
  owner_backup_user_id?: string | null;
  review_due_at?: string | null;
  change_log?: string;
}

export type ProfileLifecycleStatus = NonNullable<Profile['lifecycle_status']>;

export async function transitionCustomProfileLifecycle(
  id: number,
  input: {
    status: ProfileLifecycleStatus;
    note?: string;
    publish_version?: number;
    next_review_at?: string;
  },
): Promise<Profile> {
  const args = { param: { id: String(id) }, json: input };
  const res = await rpc.api.profiles.custom[':id'].lifecycle.$post(args);
  if (!res.ok) {
    const data = await res.json();
    throw new Error(('error' in data && data.error) || 'Failed to update Agent lifecycle');
  }
  return res.json();
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
    throw new Error(('error' in data && data.error) || 'Failed to fork Agent');
  }
  return res.json();
}
