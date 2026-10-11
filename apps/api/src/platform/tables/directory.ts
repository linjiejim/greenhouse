/**
 * The people and groups a member may name when sharing Tables things.
 *
 * Groups follow D12: a member may grant (or name in a form audience / notify
 * list) only a group they can see — one they created or belong to; a super
 * sees every group. The same set `/api/groups` lists. Used by the plan tool's
 * draft check and by `tables_query directory.search`.
 */

import type { DatabaseProvider } from '@greenhouse/db';

export interface GrantableGroup {
  id: number;
  name: string;
  /** Who controls its membership (granting the group delegates "who gets in" to them). */
  managedBy: { id: string; name: string };
}

export async function grantableGroups(db: DatabaseProvider, userId: string): Promise<GrantableGroup[]> {
  const user = await db.users.getById(userId);
  if (!user) return [];
  const groups = user.role === 'super' ? await db.groups.listAll() : await db.groups.listForUser(userId);
  const names = new Map((await db.users.list()).map((account) => [account.id, account.nickname]));
  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    managedBy: { id: group.created_by, name: names.get(group.created_by) ?? group.created_by },
  }));
}
