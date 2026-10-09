/**
 * Sessions + profiles API — list (paged, scoped, tag / agent filters), detail
 * (messages + tags + ownership), create (bound to an agent profile), rename,
 * pin, delete, and the agent-profile catalog.
 */

import type { Session, Message, SessionUsage, Profile } from '../shared/greenhouse-types';
import { api, apiJson } from './client';

export type { Session, Message, Profile };

/** One page of the session list (`page_meta=1` contract). */
export interface SessionPage {
  sessions: Session[];
  hasMore: boolean;
  /** Offset for the next page — counts the server's *unfiltered* rows, so it's not `offset + sessions.length`. */
  nextOffset: number;
}

/** Whose conversations a page lists: the member's own, or the ones others shared with them. */
export type SessionScope = 'mine' | 'shared';

/**
 * One page of active sessions, or `null` when the request failed (so a list
 * can tell "no conversations" from "couldn't load").
 *
 * Always scoped (default `mine`, like the web sidebar): without a scope the
 * server returns its legacy combined list — a super gets every member's
 * conversations, a team member up to 200 shared ones mixed in — which put
 * other people's read-only rows (no long-press menu) among the member's own.
 * `profile` keeps one agent's conversations (`sprouty` / `bot:<id>` — every
 * pinned version and legacy spelling of it).
 *
 * The server applies `tag_id` *after* paging, so a filtered page can be short
 * (even empty) while more exist — always continue from `nextOffset` while
 * `hasMore`. There is no server-side title search (the web filters loaded rows
 * too); callers filter client-side.
 */
export async function fetchSessionsPage(opts?: {
  limit?: number;
  offset?: number;
  tagId?: number | null;
  scope?: SessionScope;
  profile?: string;
}): Promise<SessionPage | null> {
  const limit = opts?.limit ?? 200;
  const offset = opts?.offset ?? 0;
  const tag = opts?.tagId != null ? `&tag_id=${opts.tagId}` : '';
  const profile = opts?.profile ? `&profile=${encodeURIComponent(opts.profile)}` : '';
  const scope = opts?.scope ?? 'mine';
  try {
    const res = await api(
      `/api/sessions?status=active&scope=${scope}&page_meta=1&limit=${limit}&offset=${offset}${tag}${profile}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      sessions?: Session[];
      page?: { has_more?: boolean; next_offset?: number };
    };
    const sessions = data.sessions ?? [];
    return {
      sessions,
      hasMore: data.page?.has_more ?? sessions.length >= limit,
      nextOffset: data.page?.next_offset ?? offset + sessions.length,
    };
  } catch {
    return null;
  }
}

/** The first page as a plain list, empty on failure (best-effort callers: the widget snapshot). */
export async function listSessions(opts?: { limit?: number; tagId?: number | null }): Promise<Session[]> {
  return (await fetchSessionsPage(opts))?.sessions ?? [];
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
  const attempt = (pid: string) =>
    api('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, profile_id: pid }),
    });
  try {
    let res = await attempt(profileId);
    // A Bot's profile may be gone (archived), a station may not know
    // Sprouty — don't let it block a new conversation: retry once with the
    // server's default.
    if (!res.ok && profileId !== 'default' && [400, 403, 404].includes(res.status)) {
      res = await attempt('default');
    }
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Rename a conversation (PATCH /api/sessions/:id — owners only). */
export async function updateSessionTitle(id: string, title: string): Promise<boolean> {
  try {
    const res = await api(`/api/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Pin / unpin a conversation for the member (their own "Pinned" group — any session they can see). */
export async function setSessionPinned(id: string, pinned: boolean): Promise<boolean> {
  try {
    const res = await api(`/api/sessions/${id}/pin`, { method: pinned ? 'POST' : 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteSession(id: string): Promise<boolean> {
  try {
    const res = await api(`/api/sessions/${id}`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listProfiles(): Promise<Profile[]> {
  const data = await apiJson<{ profiles: Profile[] }>('/api/profiles', { profiles: [] });
  return data.profiles ?? [];
}
