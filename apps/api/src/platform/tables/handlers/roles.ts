/**
 * Custom Base roles (row / field rules). Owner (or super) only, custom roles
 * refused. Rules are shape-checked by `normalizeAccessRules` (tables outside
 * the Base dropped, row predicates never touched) before they are stored;
 * compiling them is `access.ts`'s job. A role still referenced by a person, a
 * group or the team default cannot be deleted — 409 `role_in_use` with the
 * counts (D13), so access is reassigned on purpose, never by accident.
 */

import { effectiveUserId } from '@greenhouse/platform-kernel';
import type { TableBaseRoleRow } from '@greenhouse/db';
import { normalizeAccessRules, type TableBaseRoleView } from '@greenhouse/types/table-access';
import { baseForRole, requireBase } from '../access.js';
import {
  fail,
  nullableString,
  ok,
  optionalNumber,
  payloadOf,
  positiveInt,
  stringValue,
  type Handler,
  type TablesHandlers,
} from './shared.js';

export function roleView(row: TableBaseRoleRow): TableBaseRoleView {
  return {
    id: row.id,
    baseId: row.base_id,
    name: row.name,
    description: row.description,
    rules: row.rules,
    position: row.position,
    revision: row.revision,
  };
}

/**
 * The roles of a Base with how many grants use each, plus the schema facts
 * (tables, fields, dependency edges) the rule editor feeds to the same
 * `computeFieldAccess` the server compiles with.
 */
const listRoles: Handler = async (request, context) => {
  const baseId = positiveInt(payloadOf(request), 'baseId');
  if (!baseId) return fail('INVALID_INPUT', 'baseId is required');
  if (!(await requireBase(context, request.actor, baseId, 'role', 'owner'))) return fail('NOT_FOUND', 'Base not found');
  const [roles, references, facts] = await Promise.all([
    context.db.tables.listBaseRoles(baseId),
    context.db.tables.listRoleReferences(baseId),
    context.db.tables.loadAccessFacts(baseId),
  ]);
  return ok({
    roles: roles.map(roleView),
    references: roles.map((role) => ({
      roleId: role.id,
      ...(references.get(role.id) ?? { users: 0, groups: 0, team: false }),
    })),
    facts,
  });
};

const createRole: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const baseId = positiveInt(payload, 'baseId');
  const name = stringValue(payload, 'name');
  if (!baseId || !name) return fail('INVALID_INPUT', 'baseId and name are required');
  if (!(await requireBase(context, request.actor, baseId, 'role', 'owner'))) return fail('NOT_FOUND', 'Base not found');
  const rules = normalizeAccessRules(payload.rules, await context.db.tables.loadAccessFacts(baseId));
  if (!rules.ok) return fail('INVALID_INPUT', rules.error);
  const role = await context.db.tables.createBaseRole({
    base_id: baseId,
    name,
    description: nullableString(payload, 'description'),
    rules: rules.rules,
    created_by: effectiveUserId(request.actor),
  });
  return ok({ role: roleView(role) });
};

const updateRole: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const roleId = positiveInt(payload, 'roleId');
  const revision = positiveInt(payload, 'revision');
  if (!roleId || !revision) return fail('INVALID_INPUT', 'roleId and revision are required');
  const base = await baseForRole(context.db, roleId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'role', 'owner'))) {
    return fail('NOT_FOUND', 'Role not found');
  }
  let rules;
  if (payload.rules !== undefined) {
    const normalized = normalizeAccessRules(payload.rules, await context.db.tables.loadAccessFacts(base.id));
    if (!normalized.ok) return fail('INVALID_INPUT', normalized.error);
    rules = normalized.rules;
  }
  const result = await context.db.tables.updateBaseRole(roleId, {
    revision,
    name: stringValue(payload, 'name'),
    description: nullableString(payload, 'description'),
    rules,
    position: optionalNumber(payload, 'position'),
    updated_by: effectiveUserId(request.actor),
  });
  if (result.ok) return ok({ role: roleView(result.value) });
  return result.reason === 'conflict'
    ? fail('CONFLICT', 'Role revision conflict', { currentRevision: result.current })
    : fail('NOT_FOUND', 'Role not found');
};

const deleteRole: Handler = async (request, context) => {
  const roleId = positiveInt(payloadOf(request), 'roleId');
  if (!roleId) return fail('INVALID_INPUT', 'roleId is required');
  const base = await baseForRole(context.db, roleId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'role', 'owner'))) {
    return fail('NOT_FOUND', 'Role not found');
  }
  const result = await context.db.tables.deleteBaseRole(roleId);
  if (result.ok) return ok({ success: true as const });
  return result.reason === 'in_use'
    ? fail('CONFLICT', 'role_in_use', { reason: 'role_in_use', references: result.references })
    : fail('NOT_FOUND', 'Role not found');
};

export const roleHandlers = {
  listRoles,
  createRole,
  updateRole,
  deleteRole,
} satisfies TablesHandlers;
