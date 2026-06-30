/**
 * User groups API client — groups are reusable sharing targets ("小组").
 */

import type { UserGroup, GroupMember } from '@greenhouse/types/api';
import { rpc } from './client';

export async function listGroups(): Promise<UserGroup[]> {
  const res = await rpc.api.groups.$get();
  if (!res.ok) {
    // This route types no error body (errors come from middleware), so probe it.
    const data = await res.json().catch(() => null);
    const msg = data && 'error' in data && typeof data.error === 'string' ? data.error : undefined;
    throw new Error(msg || 'Failed to load groups');
  }
  return (await res.json()).groups;
}

export async function getGroup(id: number): Promise<{ group: UserGroup; members: GroupMember[] }> {
  const res = await rpc.api.groups[':id'].$get({ param: { id: String(id) } });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && 'error' in data && data.error) || 'Failed to load group');
  }
  return res.json();
}

export async function createGroup(input: {
  name: string;
  description?: string;
  member_ids?: string[];
}): Promise<UserGroup> {
  const res = await rpc.api.groups.$post({ json: input });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && 'error' in data && data.error) || 'Failed to create group');
  }
  return (await res.json()).group;
}

export async function updateGroup(id: number, updates: { name?: string; description?: string }): Promise<UserGroup> {
  // Non-literal arg: hc only types `json` for validator-backed routes (none yet);
  // the indirection passes the body while keeping param/response typing.
  const args = { param: { id: String(id) }, json: updates };
  const res = await rpc.api.groups[':id'].$patch(args);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && 'error' in data && data.error) || 'Failed to update group');
  }
  const { group } = await res.json();
  // Server types `group` as nullable (update() can miss if the row vanished
  // mid-request); surface that instead of returning null as a UserGroup.
  if (!group) throw new Error('Failed to update group');
  return group;
}

export async function deleteGroup(id: number): Promise<void> {
  const res = await rpc.api.groups[':id'].$delete({ param: { id: String(id) } });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && 'error' in data && data.error) || 'Failed to delete group');
  }
}

export async function addGroupMembers(id: number, userIds: string[]): Promise<void> {
  const args = { param: { id: String(id) }, json: { user_ids: userIds } };
  const res = await rpc.api.groups[':id'].members.$post(args);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && 'error' in data && data.error) || 'Failed to add members');
  }
}

export async function removeGroupMember(id: number, userId: string): Promise<void> {
  // encodeURIComponent matches the previous hand-built URL byte-for-byte
  // (the server decodeURIComponent()s the param on top of router decoding).
  const res = await rpc.api.groups[':id'].members[':userId'].$delete({
    param: { id: String(id), userId: encodeURIComponent(userId) },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && 'error' in data && data.error) || 'Failed to remove member');
  }
}
