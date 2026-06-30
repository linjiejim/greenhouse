/**
 * Session Groups API — per-user folder CRUD, reordering, and membership.
 *
 * Pin/unpin and "file into folder" are per-session actions and live on the
 * sessions module (./sessions). This module covers the group library itself.
 */

import type { SessionGroup } from '@greenhouse/types/api';
import { rpc } from './client';

export async function listSessionGroups(): Promise<SessionGroup[]> {
  try {
    const res = await rpc.api['session-groups'].$get();
    if (!res.ok) return [];
    return (await res.json()).groups ?? [];
  } catch {
    return [];
  }
}

export async function createSessionGroup(name: string, color?: string, icon?: string): Promise<SessionGroup> {
  const res = await rpc.api['session-groups'].$post({ json: { name, color, icon } });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Create failed' }));
    throw new Error(('error' in err && err.error) || `Create failed: ${res.status}`);
  }
  return res.json();
}

export async function updateSessionGroup(
  id: number,
  updates: { name?: string; color?: string; icon?: string; sort_order?: number },
): Promise<SessionGroup> {
  // Non-literal arg: hc only types `json` for validator-backed routes (none yet);
  // the indirection passes the body while keeping param/response typing.
  const args = { param: { id: String(id) }, json: updates };
  const res = await rpc.api['session-groups'][':id'].$patch(args);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Update failed' }));
    throw new Error(('error' in err && err.error) || `Update failed: ${res.status}`);
  }
  return res.json();
}

export async function deleteSessionGroup(id: number): Promise<void> {
  const res = await rpc.api['session-groups'][':id'].$delete({ param: { id: String(id) } });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

export async function reorderSessionGroups(updates: Array<{ id: number; sort_order: number }>): Promise<void> {
  const res = await rpc.api['session-groups'].reorder.$post({ json: { updates } });
  if (!res.ok) throw new Error(`Reorder failed: ${res.status}`);
}

/** Reorder the sessions within one group (Pinned or a folder). */
export async function reorderGroupMembers(
  groupId: number,
  updates: Array<{ session_id: string; sort_order: number }>,
): Promise<void> {
  // Non-literal arg: hc only types `json` for validator-backed routes (none yet);
  // the indirection passes the body while keeping param typing.
  const args = { param: { gid: String(groupId) }, json: { updates } };
  const res = await rpc.api['session-groups'][':gid'].members.reorder.$post(args);
  if (!res.ok) throw new Error(`Reorder failed: ${res.status}`);
}
