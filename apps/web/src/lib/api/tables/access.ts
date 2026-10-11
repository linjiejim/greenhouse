/**
 * Tables client · Base access beyond people: group grants, custom roles
 * (row / field rules), the team role and owner transfer — plus the grant view
 * of people (`listTableBaseAccess`, which `getTableBase` deliberately leaves
 * out). All of it is the owner's (or a super's); the server refuses the rest.
 */

import type {
  TableAccessRules,
  TableBaseGroupMemberView,
  TableBaseMemberRole,
  TableBaseRoleView,
  TableGroupMemberRole,
  TableTeamRole,
} from '@greenhouse/types/table-access';
import type { TableBaseRole } from '@greenhouse/types/tables';
import type { TableBase, TableBaseAccessList, TableBaseRoleList } from '@greenhouse/types/tables-wire';
import { rpc } from '../client';
import { responseError } from './shared';

// The response shapes live in `@greenhouse/types/tables-wire` (one copy for web and mobile).
export type { TableBaseAccessList, TableBaseMemberGrant, TableBaseRoleList } from '@greenhouse/types/tables-wire';

/** A role a person can be given here. Owner is not assignable (it is transferred). */
export type TableAssignableRole = Exclude<TableBaseMemberRole, 'owner'>;
export type TablePreviousOwnerRole = Exclude<TableBaseRole, 'owner'> | 'remove';

export async function listTableBaseAccess(baseId: number): Promise<TableBaseAccessList> {
  const response = await rpc.api.tables.bases[':baseId'].members.$get({ param: { baseId: String(baseId) } });
  if (!response.ok) throw await responseError(response, 'Unable to load sharing');
  return response.json();
}

export async function setTableBaseMemberRole(
  baseId: number,
  userId: string,
  role: TableAssignableRole,
  customRoleId?: number | null,
): Promise<void> {
  const args = { param: { baseId: String(baseId), userId }, json: { role, customRoleId: customRoleId ?? undefined } };
  const response = await rpc.api.tables.bases[':baseId'].members[':userId'].$put(args);
  if (!response.ok) throw await responseError(response, 'Unable to update member');
}

export async function setTableBaseGroupRole(
  baseId: number,
  groupId: number,
  role: TableGroupMemberRole,
  customRoleId?: number | null,
): Promise<TableBaseGroupMemberView> {
  const args = {
    param: { baseId: String(baseId), groupId: String(groupId) },
    json: { role, customRoleId: customRoleId ?? undefined },
  };
  const response = await rpc.api.tables.bases[':baseId'].groups[':groupId'].$put(args);
  if (!response.ok) throw await responseError(response, 'Unable to share with the group');
  return (await response.json()).group;
}

export async function removeTableBaseGroup(baseId: number, groupId: number): Promise<void> {
  const response = await rpc.api.tables.bases[':baseId'].groups[':groupId'].$delete({
    param: { baseId: String(baseId), groupId: String(groupId) },
  });
  if (!response.ok) throw await responseError(response, 'Unable to remove the group');
}

export async function listTableBaseRoles(baseId: number): Promise<TableBaseRoleList> {
  const response = await rpc.api.tables.bases[':baseId'].roles.$get({ param: { baseId: String(baseId) } });
  if (!response.ok) throw await responseError(response, 'Unable to load roles');
  return response.json();
}

export async function createTableBaseRole(
  baseId: number,
  input: { name: string; description?: string | null; rules: TableAccessRules },
): Promise<TableBaseRoleView> {
  const args = { param: { baseId: String(baseId) }, json: input };
  const response = await rpc.api.tables.bases[':baseId'].roles.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to create the role');
  return (await response.json()).role;
}

export async function updateTableBaseRole(
  roleId: number,
  input: { revision: number; name?: string; description?: string | null; rules?: TableAccessRules },
): Promise<TableBaseRoleView> {
  const args = { param: { roleId: String(roleId) }, json: input };
  const response = await rpc.api.tables.roles[':roleId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to save the role');
  return (await response.json()).role;
}

/** 409 `role_in_use` carries `details.references` — reassign those grants first. */
export async function deleteTableBaseRole(roleId: number): Promise<void> {
  const response = await rpc.api.tables.roles[':roleId'].$delete({ param: { roleId: String(roleId) } });
  if (!response.ok) throw await responseError(response, 'Unable to delete the role');
}

export async function setTableBaseTeamRole(
  baseId: number,
  teamRole: TableTeamRole,
  teamCustomRoleId?: number | null,
): Promise<TableBase> {
  const args = {
    param: { baseId: String(baseId) },
    json: { teamRole, teamCustomRoleId: teamCustomRoleId ?? undefined },
  };
  const response = await rpc.api.tables.bases[':baseId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update the team role');
  return (await response.json()).base;
}

export async function transferTableBaseOwner(
  baseId: number,
  userId: string,
  previousOwnerRole: TablePreviousOwnerRole,
): Promise<TableBase> {
  const args = { param: { baseId: String(baseId) }, json: { userId, previousOwnerRole } };
  const response = await rpc.api.tables.bases[':baseId'].transfer.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to transfer the Base');
  return (await response.json()).base;
}
