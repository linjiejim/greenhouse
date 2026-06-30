/**
 * Session Tags API — tag CRUD and session-tag linking.
 */

import type { SessionTag } from '@greenhouse/types/api';
import { rpc } from './client';

export async function listSessionTags(): Promise<SessionTag[]> {
  try {
    const res = await rpc.api['session-tags'].$get();
    if (!res.ok) return [];
    return (await res.json()).tags ?? [];
  } catch {
    return [];
  }
}

export async function createSessionTag(name: string, color?: string): Promise<SessionTag> {
  const res = await rpc.api['session-tags'].$post({ json: { name, color } });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Create failed' }));
    throw new Error(err.error || `Create failed: ${res.status}`);
  }
  return res.json();
}

export async function updateSessionTag(
  id: number,
  updates: { name?: string; color?: string; sort_order?: number },
): Promise<SessionTag> {
  // Non-literal arg: hc only types `json` for validator-backed routes (none yet);
  // the indirection passes the body while keeping param/response typing.
  const args = { param: { id: String(id) }, json: updates };
  const res = await rpc.api['session-tags'][':id'].$patch(args);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Update failed' }));
    throw new Error(('error' in err && err.error) || `Update failed: ${res.status}`);
  }
  return res.json();
}

export async function deleteSessionTag(id: number): Promise<void> {
  const res = await rpc.api['session-tags'][':id'].$delete({ param: { id: String(id) } });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

export async function reorderSessionTags(updates: Array<{ id: number; sort_order: number }>): Promise<void> {
  const res = await rpc.api['session-tags'].reorder.$post({ json: { updates } });
  if (!res.ok) throw new Error(`Reorder failed: ${res.status}`);
}

export async function addTagToSession(sessionId: string, tagId: number): Promise<void> {
  const args = { param: { id: sessionId }, json: { tag_id: tagId } };
  const res = await rpc.api.sessions[':id'].tags.$post(args);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed' }));
    throw new Error(('error' in err && err.error) || `Failed: ${res.status}`);
  }
}

export async function removeTagFromSession(sessionId: string, tagId: number): Promise<void> {
  const res = await rpc.api.sessions[':id'].tags[':tagId'].$delete({
    param: { id: sessionId, tagId: String(tagId) },
  });
  if (!res.ok) throw new Error(`Remove failed: ${res.status}`);
}
