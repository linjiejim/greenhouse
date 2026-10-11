/**
 * Bases and who can open them: people, groups, the team default and owner
 * transfer. Only the owner (or a super) changes grants; groups never hold
 * builder (D12) and can only be granted by someone who can see the group —
 * its creator, a member, or a super (the same set `/api/groups` lists).
 * Custom roles themselves are in `./roles.ts`.
 */

import { effectiveUserId, type ActorContext } from '@greenhouse/platform-kernel';
import type { DatabaseProvider, TableBaseGroupGrantRow, TablePreviousOwnerRole } from '@greenhouse/db';
import type {
  TableBaseGroupMemberView,
  TableBaseMemberRole,
  TableGroupMemberRole,
  TableTeamRole,
} from '@greenhouse/types/table-access';
import type { TableBaseVisibility } from '@greenhouse/types/tables';
import { baseAccessView, customAccessLens, listBaseGrants, requireBase } from '../access.js';
import { visibleTables } from '../access-trim.js';
import {
  fail,
  nullableString,
  ok,
  payloadOf,
  positiveInt,
  stringValue,
  type Handler,
  type TablesHandlers,
} from './shared.js';
import { dashboardsForReader } from './dashboards.js';
import { roleView } from './roles.js';

const USER_ROLES: readonly TableBaseMemberRole[] = ['builder', 'editor', 'viewer', 'custom'];
const GROUP_ROLES: readonly TableGroupMemberRole[] = ['editor', 'viewer', 'custom'];
const TEAM_ROLES: readonly TableTeamRole[] = ['viewer', 'editor', 'custom'];
const PREVIOUS_OWNER_ROLES: readonly TablePreviousOwnerRole[] = ['builder', 'editor', 'viewer', 'remove'];

function isActiveInternal(user: { status: string; role: string } | undefined): boolean {
  return Boolean(user && user.status === 'active' && (user.role === 'team' || user.role === 'super'));
}

/** Display names of internal accounts, for the people a response mentions. */
async function userNames(db: DatabaseProvider): Promise<Map<string, string>> {
  return new Map((await db.users.list()).map((user) => [user.id, user.nickname]));
}

/** A `customRoleId` is only accepted for `custom`, and only when it is a role of this Base. */
async function sameBaseRole(db: DatabaseProvider, baseId: number, roleId: number | undefined) {
  if (!roleId) return undefined;
  const role = await db.tables.getBaseRole(roleId);
  return role && role.base_id === baseId ? role : undefined;
}

/** Can `actor` grant this group? Its creator, a member, or a super — the groups they can see (D12). */
async function grantableGroup(db: DatabaseProvider, actor: ActorContext, groupId: number) {
  const group = await db.groups.getById(groupId);
  if (!group) return undefined;
  const userId = effectiveUserId(actor);
  if (group.created_by === userId) return group;
  const account = await db.users.getById(userId);
  if (account?.role === 'super' || (await db.groups.isMember(groupId, userId))) return group;
  return undefined;
}

function groupGrantView(row: TableBaseGroupGrantRow): TableBaseGroupMemberView {
  return {
    groupId: row.group_id,
    name: row.group_name,
    role: row.role,
    customRoleId: row.custom_role_id,
    memberCount: row.member_count,
    managedBy: { id: row.group_created_by, name: row.group_creator_name ?? row.group_created_by },
  };
}

const listBases: Handler = async (request, context) => {
  const candidates = await context.db.tables.listBasesForUser(
    effectiveUserId(request.actor),
    stringValue(payloadOf(request), 'search'),
  );
  const grants = await listBaseGrants(context, request.actor, candidates);
  return ok({ bases: grants.map((grant) => ({ ...grant.base, role: grant.role })) });
};

/**
 * The workspace. A custom role sees only the tables it has a rule for, no
 * dashboards when its rules say `none` (else their filter controls trimmed to
 * what it reads), and its compiled per-table access;
 * everyone gets members as `{id, name}` only (grants are the owner's business —
 * `listMembers`).
 */
const getBase: Handler = async (request, context) => {
  const baseId = positiveInt(payloadOf(request), 'baseId');
  if (!baseId) return fail('INVALID_INPUT', 'baseId is required');
  const grant = await requireBase(context, request.actor, baseId, 'base', 'viewer', { allowCustom: true });
  if (!grant) return fail('NOT_FOUND', 'Base not found');
  const userId = effectiveUserId(request.actor);
  const [tables, dashboards, memberRows, names, access, lens] = await Promise.all([
    context.db.tables.listTables(baseId),
    context.db.tables.listDashboards(baseId),
    context.db.tables.listBaseMembers(baseId),
    userNames(context.db),
    baseAccessView(context, grant.access, userId),
    customAccessLens(context, grant.access, userId),
  ]);
  return ok({
    base: grant.base,
    role: grant.role,
    access,
    tables: lens ? visibleTables(lens, tables) : tables,
    dashboards: !lens
      ? dashboards
      : lens.rules.dashboards === 'all'
        ? await dashboardsForReader(request, context, dashboards)
        : [],
    members: memberRows.map((member) => ({ id: member.user_id, name: names.get(member.user_id) ?? member.user_id })),
  });
};

const createBase: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const name = stringValue(payload, 'name');
  if (!name) return fail('INVALID_INPUT', 'name is required');
  const userId = effectiveUserId(request.actor);
  const base = await context.db.tables.createBase({
    name,
    description: stringValue(payload, 'description'),
    visibility: payload.visibility === 'team' ? 'team' : 'private',
    owner_id: userId,
    created_by: userId,
  });
  const schema = await context.db.tables.createTable({
    base_id: base.id,
    name: stringValue(payload, 'defaultTableName') || 'Table 1',
    created_by: userId,
  });
  return ok({ base, role: 'owner', schema });
};

/**
 * Name, description, visibility and the team default (`teamRole`, plus
 * `teamCustomRoleId` for `custom` — a role of this Base). Owner only.
 */
const updateBase: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const baseId = positiveInt(payload, 'baseId');
  if (!baseId) return fail('INVALID_INPUT', 'baseId is required');
  if (!(await requireBase(context, request.actor, baseId, 'base', 'owner'))) return fail('NOT_FOUND', 'Base not found');
  const teamRole = payload.teamRole as TableTeamRole | undefined;
  if (teamRole !== undefined && !TEAM_ROLES.includes(teamRole)) {
    return fail('INVALID_INPUT', 'teamRole must be viewer, editor, or custom');
  }
  const teamCustomRole =
    teamRole === 'custom'
      ? await sameBaseRole(context.db, baseId, positiveInt(payload, 'teamCustomRoleId'))
      : undefined;
  if (teamRole === 'custom' && !teamCustomRole) {
    return fail('INVALID_INPUT', 'teamCustomRoleId must be a role of this Base');
  }
  let base = await context.db.tables.updateBase(baseId, {
    name: stringValue(payload, 'name'),
    description: nullableString(payload, 'description'),
    visibility:
      payload.visibility === 'private' || payload.visibility === 'team'
        ? (payload.visibility as TableBaseVisibility)
        : undefined,
  });
  if (base && teamRole) base = await context.db.tables.setBaseTeamRole(baseId, teamRole, teamCustomRole?.id ?? null);
  return base ? ok({ base }) : fail('NOT_FOUND', 'Base not found');
};

const archiveBase: Handler = async (request, context) => {
  const baseId = positiveInt(payloadOf(request), 'baseId');
  if (!baseId) return fail('INVALID_INPUT', 'baseId is required');
  if (!(await requireBase(context, request.actor, baseId, 'base', 'owner'))) return fail('NOT_FOUND', 'Base not found');
  const base = await context.db.tables.archiveBase(baseId);
  return base ? ok({ base }) : fail('NOT_FOUND', 'Base not found');
};

/**
 * People and group grants of a Base, for built-in members (a custom role gets
 * names through `getBase` and is refused here). The roles — and so their rules —
 * go to the owner / a super only.
 */
const listMembers: Handler = async (request, context) => {
  const baseId = positiveInt(payloadOf(request), 'baseId');
  if (!baseId) return fail('INVALID_INPUT', 'baseId is required');
  const grant = await requireBase(context, request.actor, baseId, 'base', 'viewer');
  if (!grant) return fail('NOT_FOUND', 'Base not found');
  const manager = grant.role === 'owner';
  const [members, groups, names, roles] = await Promise.all([
    context.db.tables.listBaseMembers(baseId),
    context.db.tables.listBaseGroupGrants(baseId),
    userNames(context.db),
    manager ? context.db.tables.listBaseRoles(baseId) : Promise.resolve(undefined),
  ]);
  return ok({
    members: members.map((member) => ({ ...member, name: names.get(member.user_id) ?? member.user_id })),
    groups: groups.map(groupGrantView),
    ...(roles ? { roles: roles.map(roleView) } : {}),
  });
};

async function manageGroupGrant(
  request: Parameters<Handler>[0],
  context: Parameters<Handler>[1],
  baseId: number,
  payload: Record<string, unknown>,
) {
  const groupId = positiveInt(payload, 'groupId');
  if (!groupId) return fail('INVALID_INPUT', 'groupId is required');
  if (payload.operation === 'remove') {
    // Taking a grant away only narrows access, so it needs no view of the group.
    return (await context.db.tables.removeBaseGroupGrant(baseId, groupId))
      ? ok({ success: true })
      : fail('NOT_FOUND', 'Group grant not found');
  }
  const role = payload.role as TableGroupMemberRole;
  if (!GROUP_ROLES.includes(role)) {
    return fail('INVALID_INPUT', 'A group can be editor, viewer, or custom — builder is granted to people only');
  }
  // Unknown and invisible groups look the same: whoever controls a group decides who gets in (D12).
  if (!(await grantableGroup(context.db, request.actor, groupId))) return fail('NOT_FOUND', 'Group not found');
  const customRole =
    role === 'custom' ? await sameBaseRole(context.db, baseId, positiveInt(payload, 'customRoleId')) : undefined;
  if (role === 'custom' && !customRole) return fail('INVALID_INPUT', 'customRoleId must be a role of this Base');
  await context.db.tables.upsertBaseGroupGrant({
    base_id: baseId,
    group_id: groupId,
    role,
    custom_role_id: customRole?.id ?? null,
    added_by: effectiveUserId(request.actor),
  });
  const grant = (await context.db.tables.listBaseGroupGrants(baseId)).find((row) => row.group_id === groupId);
  return grant ? ok({ group: groupGrantView(grant) }) : fail('NOT_FOUND', 'Group not found');
}

/**
 * Add, change or remove one grant. `principal: 'user'` (default; `userId`,
 * role builder / editor / viewer / custom) or `'group'` (`groupId`, role
 * editor / viewer / custom). `custom` needs `customRoleId` of this Base.
 */
const manageMembers: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const baseId = positiveInt(payload, 'baseId');
  if (!baseId) return fail('INVALID_INPUT', 'baseId is required');
  const grant = await requireBase(context, request.actor, baseId, 'base', 'owner');
  if (!grant) return fail('NOT_FOUND', 'Base not found');
  if (payload.principal === 'group') return manageGroupGrant(request, context, baseId, payload);

  const userId = stringValue(payload, 'userId');
  if (!userId) return fail('INVALID_INPUT', 'userId is required');
  if (userId === grant.base.owner_id) return fail('CONFLICT', 'The Base owner cannot be changed here');
  if (payload.operation === 'remove') {
    return (await context.db.tables.removeBaseMember(baseId, userId))
      ? ok({ success: true })
      : fail('NOT_FOUND', 'Member not found');
  }
  const role = payload.role as TableBaseMemberRole;
  if (!USER_ROLES.includes(role)) return fail('INVALID_INPUT', 'role must be builder, editor, viewer, or custom');
  const target = await context.db.users.getById(userId);
  if (!isActiveInternal(target)) return fail('INVALID_INPUT', 'Member must be an active internal user');
  const customRole =
    role === 'custom' ? await sameBaseRole(context.db, baseId, positiveInt(payload, 'customRoleId')) : undefined;
  if (role === 'custom' && !customRole) return fail('INVALID_INPUT', 'customRoleId must be a role of this Base');
  const member = await context.db.tables.upsertBaseMember({
    base_id: baseId,
    user_id: userId,
    role,
    custom_role_id: customRole?.id ?? null,
    added_by: effectiveUserId(request.actor),
  });
  return ok({ member });
};

/**
 * Hand the Base to another active internal user. The previous owner stays as
 * `previousOwnerRole` (builder / editor / viewer) or is removed. Owner or super.
 */
const transferBaseOwner: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const baseId = positiveInt(payload, 'baseId');
  const userId = stringValue(payload, 'userId');
  const previousOwnerRole = payload.previousOwnerRole as TablePreviousOwnerRole;
  if (!baseId || !userId) return fail('INVALID_INPUT', 'baseId and userId are required');
  if (!PREVIOUS_OWNER_ROLES.includes(previousOwnerRole)) {
    return fail('INVALID_INPUT', 'previousOwnerRole must be builder, editor, viewer, or remove');
  }
  const grant = await requireBase(context, request.actor, baseId, 'base', 'owner');
  if (!grant) return fail('NOT_FOUND', 'Base not found');
  if (userId === grant.base.owner_id) return fail('CONFLICT', 'This person already owns the Base');
  if (!isActiveInternal(await context.db.users.getById(userId))) {
    return fail('INVALID_INPUT', 'The new owner must be an active internal user');
  }
  const base = await context.db.tables.transferBaseOwner(baseId, {
    newOwnerId: userId,
    previousOwnerRole,
    actorId: effectiveUserId(request.actor),
  });
  return base ? ok({ base }) : fail('NOT_FOUND', 'Base not found');
};

const listAssignableUsers: Handler = async (_request, context) => {
  const users = await context.db.users.list();
  return ok({
    users: users
      .filter((user) => isActiveInternal(user))
      .map((user) => ({ id: user.id, nickname: user.nickname, email: user.email, role: user.role })),
  });
};

export const baseHandlers = {
  listBases,
  getBase,
  createBase,
  updateBase,
  archiveBase,
  listMembers,
  manageMembers,
  transferBaseOwner,
  listAssignableUsers,
} satisfies TablesHandlers;
