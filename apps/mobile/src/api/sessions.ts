/**
 * Sessions + profiles API.
 */

import type { Session, Message, SessionUsage, Profile } from '../shared/greenhouse-types';
import { api, apiJson } from './client';

export type { Session, Message, Profile };

/**
 * List active sessions. Pass {limit, offset} to page (backend supports both).
 * `search` filters by title server-side (case-insensitive substring) so a match
 * on an unloaded page is still reachable via pagination.
 */
export async function listSessions(opts?: {
  limit?: number;
  offset?: number;
  tagId?: number | null;
  search?: string;
}): Promise<Session[]> {
  const limit = opts?.limit ?? 200;
  const offset = opts?.offset ?? 0;
  const tag = opts?.tagId != null ? `&tag_id=${opts.tagId}` : '';
  const q = opts?.search ? `&q=${encodeURIComponent(opts.search)}` : '';
  const data = await apiJson<{ sessions: Session[] }>(
    `/api/sessions?status=active&limit=${limit}&offset=${offset}${tag}${q}`,
    { sessions: [] },
  );
  return data.sessions ?? [];
}

export async function getSession(
  id: string,
): Promise<{ session: Session; messages: Message[]; usage?: SessionUsage } | null> {
  try {
    const res = await api(`/api/sessions/${id}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function createSession(profileId = 'default', title?: string): Promise<Session | null> {
  try {
    const res = await api('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, profile_id: profileId }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function deleteSession(id: string): Promise<void> {
  await api(`/api/sessions/${id}`, { method: 'DELETE' });
}

export async function listProfiles(): Promise<Profile[]> {
  const data = await apiJson<{ profiles: Profile[] }>('/api/profiles', { profiles: [] });
  return data.profiles ?? [];
}
