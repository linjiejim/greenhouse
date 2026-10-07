/**
 * Profiles API — the identities the member may run (their Sprouty, their Bots,
 * shared Bots) and the usage summary. Bot management lives in ./bots.
 */

import type { Profile, ProfileDetail, UsageSummary } from '@greenhouse/types/api';
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
