/**
 * Session-tags API — per-user tag definitions + per-session assignment.
 * Mirrors the web app's lib/api/session-tags (minus reorder: mobile keeps the
 * web's order and does not offer drag-to-reorder). All endpoints require an
 * authenticated internal user; the server enforces the limits (20 tags/user,
 * 5 tags/session) and returns an English `error` string we surface to the UI.
 */

import type { SessionTag } from '../shared/greenhouse-types';
import { api, apiJson } from './client';

export const MAX_TAGS_PER_USER = 20;
export const MAX_TAGS_PER_SESSION = 5;

/** Current user's tags, ordered by sort_order. null = the request failed (offline / server error). */
export async function listTags(): Promise<SessionTag[] | null> {
  const data = await apiJson<{ tags?: SessionTag[] } | null>('/api/session-tags', null);
  return data ? (data.tags ?? []) : null;
}

async function mutate(
  path: string,
  method: string,
  body?: unknown,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  try {
    const res = await api(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (data as { error?: string })?.error };
    return { ok: true, data };
  } catch {
    return { ok: false };
  }
}

export async function createTag(
  name: string,
  color: string,
): Promise<{ ok: boolean; tag?: SessionTag; error?: string }> {
  const r = await mutate('/api/session-tags', 'POST', { name, color });
  return { ok: r.ok, tag: r.data as SessionTag | undefined, error: r.error };
}

export async function updateTag(
  id: number,
  patch: { name?: string; color?: string; sort_order?: number },
): Promise<{ ok: boolean; tag?: SessionTag; error?: string }> {
  const r = await mutate(`/api/session-tags/${id}`, 'PATCH', patch);
  return { ok: r.ok, tag: r.data as SessionTag | undefined, error: r.error };
}

export async function deleteTag(id: number): Promise<boolean> {
  return (await mutate(`/api/session-tags/${id}`, 'DELETE')).ok;
}

/**
 * One session's assigned tags + whether the caller owns it (only owners may
 * change them). Reads the session detail without its messages, so it is cheap
 * enough to call whenever the tag sheet opens. null = unreachable / no access.
 */
export async function getSessionTags(sessionId: string): Promise<{ tags: SessionTag[]; isOwner: boolean } | null> {
  try {
    const res = await api(`/api/sessions/${sessionId}?include_messages=0`);
    if (!res.ok) return null;
    const data = (await res.json()) as { session?: { tags?: SessionTag[]; is_owner?: boolean } };
    return { tags: data.session?.tags ?? [], isOwner: data.session?.is_owner !== false };
  } catch {
    return null;
  }
}

/** Attach a tag to a session (idempotent server-side). */
export async function addTagToSession(sessionId: string, tagId: number): Promise<{ ok: boolean; error?: string }> {
  const r = await mutate(`/api/sessions/${sessionId}/tags`, 'POST', { tag_id: tagId });
  return { ok: r.ok, error: r.error };
}

/** Detach a tag from a session (no-op if not attached). */
export async function removeTagFromSession(sessionId: string, tagId: number): Promise<boolean> {
  return (await mutate(`/api/sessions/${sessionId}/tags/${tagId}`, 'DELETE')).ok;
}
