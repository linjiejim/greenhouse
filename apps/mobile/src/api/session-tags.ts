/**
 * Session-tags API — per-user tag definitions + per-session assignment.
 * Mirrors the web app's lib/api/session-tags. All endpoints require an
 * authenticated internal user; the server enforces the limits (20 tags/user,
 * 5 tags/session) and returns an English `error` string we surface to the UI.
 */

import type { SessionTag } from '../shared/greenhouse-types';
import { api, apiJson } from './client';

export const MAX_TAGS_PER_USER = 20;
export const MAX_TAGS_PER_SESSION = 5;

/** Current user's tags, ordered by sort_order. */
export async function listTags(): Promise<SessionTag[]> {
  const data = await apiJson<{ tags: SessionTag[] }>('/api/session-tags', { tags: [] });
  return data.tags ?? [];
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

export async function reorderTags(updates: Array<{ id: number; sort_order: number }>): Promise<boolean> {
  return (await mutate('/api/session-tags/reorder', 'POST', { updates })).ok;
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
