/**
 * Bases and members. Group grants, custom roles, the team role and owner
 * transfer arrive with slice A (`transferBaseOwner` is declared, not built).
 */

import { effectiveUserId } from '@greenhouse/platform-kernel';
import type { TableBaseVisibility } from '@greenhouse/types/tables';
import { accessView, listBaseGrants, requireBase } from '../access.js';
import {
  fail,
  notImplemented,
  nullableString,
  ok,
  payloadOf,
  positiveInt,
  stringValue,
  type Handler,
  type TablesHandlers,
} from './shared.js';

const listBases: Handler = async (request, context) => {
  const candidates = await context.db.tables.listBasesForUser(
    effectiveUserId(request.actor),
    stringValue(payloadOf(request), 'search'),
  );
  const grants = await listBaseGrants(context, request.actor, candidates);
  return ok({ bases: grants.map((grant) => ({ ...grant.base, role: grant.role })) });
};

const getBase: Handler = async (request, context) => {
  const baseId = positiveInt(payloadOf(request), 'baseId');
  if (!baseId) return fail('INVALID_INPUT', 'baseId is required');
  const grant = await requireBase(context, request.actor, baseId, 'base', 'viewer');
  if (!grant) return fail('NOT_FOUND', 'Base not found');
  const [tables, dashboards, members] = await Promise.all([
    context.db.tables.listTables(baseId),
    context.db.tables.listDashboards(baseId),
    context.db.tables.listBaseMembers(baseId),
  ]);
  return ok({ base: grant.base, role: grant.role, access: accessView(grant.access), tables, dashboards, members });
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

const updateBase: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const baseId = positiveInt(payload, 'baseId');
  if (!baseId) return fail('INVALID_INPUT', 'baseId is required');
  if (!(await requireBase(context, request.actor, baseId, 'base', 'owner'))) return fail('NOT_FOUND', 'Base not found');
  const base = await context.db.tables.updateBase(baseId, {
    name: stringValue(payload, 'name'),
    description: nullableString(payload, 'description'),
    visibility:
      payload.visibility === 'private' || payload.visibility === 'team'
        ? (payload.visibility as TableBaseVisibility)
        : undefined,
  });
  return base ? ok({ base }) : fail('NOT_FOUND', 'Base not found');
};

const archiveBase: Handler = async (request, context) => {
  const baseId = positiveInt(payloadOf(request), 'baseId');
  if (!baseId) return fail('INVALID_INPUT', 'baseId is required');
  if (!(await requireBase(context, request.actor, baseId, 'base', 'owner'))) return fail('NOT_FOUND', 'Base not found');
  const base = await context.db.tables.archiveBase(baseId);
  return base ? ok({ base }) : fail('NOT_FOUND', 'Base not found');
};

const listMembers: Handler = async (request, context) => {
  const baseId = positiveInt(payloadOf(request), 'baseId');
  if (!baseId) return fail('INVALID_INPUT', 'baseId is required');
  if (!(await requireBase(context, request.actor, baseId, 'base', 'viewer')))
    return fail('NOT_FOUND', 'Base not found');
  return ok({ members: await context.db.tables.listBaseMembers(baseId) });
};

const manageMembers: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const baseId = positiveInt(payload, 'baseId');
  const userId = stringValue(payload, 'userId');
  if (!baseId || !userId) return fail('INVALID_INPUT', 'baseId and userId are required');
  const grant = await requireBase(context, request.actor, baseId, 'base', 'owner');
  if (!grant) return fail('NOT_FOUND', 'Base not found');
  if (userId === grant.base.owner_id) return fail('CONFLICT', 'The Base owner cannot be changed here');
  if (payload.operation === 'remove') {
    return (await context.db.tables.removeBaseMember(baseId, userId))
      ? ok({ success: true })
      : fail('NOT_FOUND', 'Member not found');
  }
  if (!['builder', 'editor', 'viewer'].includes(String(payload.role))) {
    return fail('INVALID_INPUT', 'role must be builder, editor, or viewer');
  }
  const target = await context.db.users.getById(userId);
  if (!target || target.status !== 'active' || (target.role !== 'team' && target.role !== 'super')) {
    return fail('INVALID_INPUT', 'Member must be an active internal user');
  }
  const member = await context.db.tables.upsertBaseMember({
    base_id: baseId,
    user_id: userId,
    role: payload.role as 'builder' | 'editor' | 'viewer',
    added_by: effectiveUserId(request.actor),
  });
  return ok({ member });
};

const listAssignableUsers: Handler = async (_request, context) => {
  const users = await context.db.users.list();
  return ok({
    users: users
      .filter((user) => user.status === 'active' && (user.role === 'team' || user.role === 'super'))
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
  listAssignableUsers,
  // Slice A.
  transferBaseOwner: notImplemented,
} satisfies TablesHandlers;
