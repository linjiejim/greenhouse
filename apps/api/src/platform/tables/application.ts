/**
 * Tables runtime application.
 *
 * Every HTTP/Agent/MCP call dispatches these handlers. Platform capability and
 * entity policy are intersected with Base membership roles before db.tables is
 * invoked, preventing transport-specific authorization drift.
 */

import {
  canAccessRecord,
  effectiveUserId,
  fieldPolicyFor,
  resolveEntityPolicy,
  type ActorContext,
  type ApplicationRegistration,
  type EntityPolicy,
  type PlatformActionHandler,
  type PlatformActionResult,
} from '@greenhouse/platform-kernel';
import { TablesValidationError, type DatabaseProvider, type TableBaseRow } from '@greenhouse/db';
import type {
  TableAggregateInput,
  TableBaseRole,
  TableBaseVisibility,
  TableFieldConfig,
  TableFieldType,
  TableQuery,
  TableRecordValues,
  TableViewConfig,
  TableViewScope,
} from '@greenhouse/types/tables';
import { TABLE_FIELD_TYPES } from '@greenhouse/types/tables';
import { isUniqueViolation } from '@greenhouse/utils/error';
import { tablesManifest } from '../manifests/tables.js';
import type { PlatformHandlerContext } from '../runtime.js';

export type TablesActionId = keyof typeof tablesManifest.actions;
type Handler = PlatformActionHandler<PlatformHandlerContext>;
type RequiredRole = 'viewer' | 'editor' | 'builder' | 'owner';

const ROLE_RANK: Record<RequiredRole, number> = {
  viewer: 0,
  editor: 1,
  builder: 2,
  owner: 3,
};

function ok<T>(data: T): PlatformActionResult<T> {
  return { ok: true, data };
}

function fail(
  code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'INTERNAL_ERROR',
  message: string,
  details?: Record<string, unknown>,
): PlatformActionResult {
  return { ok: false, code, message, ...(details ? { details } : {}) };
}

function payloadOf(request: Parameters<Handler>[0]): Record<string, unknown> {
  return request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload)
    ? (request.payload as Record<string, unknown>)
    : {};
}

function positiveInt(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function stringValue(payload: Record<string, unknown>, key: string): string | undefined {
  return typeof payload[key] === 'string' ? (payload[key] as string) : undefined;
}

function objectValue<T extends object>(payload: Record<string, unknown>, key: string): T | undefined {
  const value = payload[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : undefined;
}

async function entityPolicy(
  context: PlatformHandlerContext,
  actor: ActorContext,
  entityId: string,
): Promise<EntityPolicy> {
  const snapshot = await context.db.platform.getEntityPolicySnapshot({
    orgId: actor.orgId,
    userId: effectiveUserId(actor),
    appId: tablesManifest.id,
    entityId,
  });
  return resolveEntityPolicy(snapshot.rolePolicies, snapshot.userOverride);
}

async function baseRole(
  context: PlatformHandlerContext,
  actor: ActorContext,
  base: TableBaseRow,
  entityId: string,
): Promise<TableBaseRole | undefined> {
  if (base.archived_at) return undefined;
  const userId = effectiveUserId(actor);
  const [user, members, policy] = await Promise.all([
    context.db.users.getById(userId),
    context.db.tables.listBaseMembers(base.id),
    entityPolicy(context, actor, entityId),
  ]);
  if (!user || user.status !== 'active' || (user.role !== 'team' && user.role !== 'super')) return undefined;
  const collaborators = members.map((member) => member.user_id);
  if (
    !canAccessRecord(
      actor,
      {
        ownerId: base.owner_id,
        collaboratorIds: collaborators,
      },
      policy,
    )
  ) {
    return undefined;
  }
  if (user.role === 'super' || base.owner_id === userId) return 'owner';
  const explicit = members.find((member) => member.user_id === userId);
  if (explicit) return explicit.role;
  return base.visibility === 'team' ? 'viewer' : undefined;
}

async function requireBase(
  context: PlatformHandlerContext,
  actor: ActorContext,
  baseId: number,
  entityId: string,
  required: RequiredRole,
): Promise<{ base: TableBaseRow; role: TableBaseRole } | undefined> {
  const base = await context.db.tables.getBase(baseId);
  if (!base) return undefined;
  const role = await baseRole(context, actor, base, entityId);
  if (!role || ROLE_RANK[role] < ROLE_RANK[required]) return undefined;
  return { base, role };
}

async function baseForTable(db: DatabaseProvider, tableId: number): Promise<TableBaseRow | undefined> {
  const table = await db.tables.getTable(tableId);
  return table ? db.tables.getBase(table.base_id) : undefined;
}

async function baseForField(db: DatabaseProvider, fieldId: number): Promise<TableBaseRow | undefined> {
  const field = await db.tables.getField(fieldId);
  return field ? baseForTable(db, field.table_id) : undefined;
}

async function baseForView(db: DatabaseProvider, viewId: number): Promise<TableBaseRow | undefined> {
  const view = await db.tables.getView(viewId);
  return view ? baseForTable(db, view.table_id) : undefined;
}

function wrap(handler: Handler): Handler {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      if (error instanceof TablesValidationError) return fail('INVALID_INPUT', error.message);
      // Drizzle puts the pg code on err.cause, so the old top-level-only check
      // never matched and every duplicate name surfaced as a 500 instead.
      if (isUniqueViolation(error)) return fail('CONFLICT', 'A resource with this name already exists');
      throw error;
    }
  };
}

const listBases: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const userId = effectiveUserId(request.actor);
  const candidates = await context.db.tables.listBasesForUser(userId, stringValue(payload, 'search'));
  const bases = [];
  for (const base of candidates) {
    const role = await baseRole(context, request.actor, base, 'base');
    if (role) bases.push({ ...base, role });
  }
  return ok({ bases });
};

const getBase: Handler = async (request, context) => {
  const baseId = positiveInt(payloadOf(request), 'baseId');
  if (!baseId) return fail('INVALID_INPUT', 'baseId is required');
  const access = await requireBase(context, request.actor, baseId, 'base', 'viewer');
  if (!access) return fail('NOT_FOUND', 'Base not found');
  const [tables, members] = await Promise.all([
    context.db.tables.listTables(baseId),
    context.db.tables.listBaseMembers(baseId),
  ]);
  return ok({ base: access.base, role: access.role, tables, members });
};

const createBase: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const name = stringValue(payload, 'name');
  if (!name) return fail('INVALID_INPUT', 'name is required');
  const userId = effectiveUserId(request.actor);
  const visibility = payload.visibility === 'team' ? 'team' : 'private';
  const base = await context.db.tables.createBase({
    name,
    description: typeof payload.description === 'string' ? payload.description : undefined,
    visibility,
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
  const access = await requireBase(context, request.actor, baseId, 'base', 'owner');
  if (!access) return fail('NOT_FOUND', 'Base not found');
  const base = await context.db.tables.updateBase(baseId, {
    name: stringValue(payload, 'name'),
    description:
      payload.description === null || typeof payload.description === 'string'
        ? (payload.description as string | null)
        : undefined,
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
  const access = await requireBase(context, request.actor, baseId, 'base', 'owner');
  if (!access) return fail('NOT_FOUND', 'Base not found');
  const base = await context.db.tables.archiveBase(baseId);
  return base ? ok({ base }) : fail('NOT_FOUND', 'Base not found');
};

const listMembers: Handler = async (request, context) => {
  const baseId = positiveInt(payloadOf(request), 'baseId');
  if (!baseId) return fail('INVALID_INPUT', 'baseId is required');
  const access = await requireBase(context, request.actor, baseId, 'base', 'viewer');
  if (!access) return fail('NOT_FOUND', 'Base not found');
  const members = await context.db.tables.listBaseMembers(baseId);
  return ok({ members });
};

const listBaseAudit: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const baseId = positiveInt(payload, 'baseId');
  if (!baseId) return fail('INVALID_INPUT', 'baseId is required');
  if (!(await requireBase(context, request.actor, baseId, 'base', 'owner'))) {
    return fail('NOT_FOUND', 'Base not found');
  }
  const limit = Math.min(positiveInt(payload, 'limit') ?? 100, 200);
  const candidates = await context.db.platform.listAuditEventsForApp(
    request.actor.orgId,
    tablesManifest.id,
    Math.min(limit * 4, 500),
  );
  const tableBaseCache = new Map<number, number | undefined>();

  const baseFromTable = async (tableId: number) => {
    if (!tableBaseCache.has(tableId)) {
      tableBaseCache.set(tableId, (await context.db.tables.getTable(tableId))?.base_id);
    }
    return tableBaseCache.get(tableId);
  };
  const eventBaseId = async (event: (typeof candidates)[number]): Promise<number | undefined> => {
    const id = Number(event.record_id);
    if (!Number.isInteger(id) || id <= 0) return undefined;
    if (
      [
        'getBase',
        'updateBase',
        'archiveBase',
        'listMembers',
        'manageMembers',
        'listBaseAudit',
        'listTables',
        'createTable',
      ].includes(event.action_id)
    ) {
      return id;
    }
    if (
      [
        'getSchema',
        'listSchemaVersions',
        'getSchemaVersion',
        'updateTable',
        'archiveTable',
        'createField',
        'listViews',
        'createView',
        'queryRecords',
        'aggregateRecords',
        'createRecord',
        'validateBatchRecords',
        'batchUpsertRecords',
        'listDeletedRecords',
      ].includes(event.action_id)
    ) {
      return baseFromTable(id);
    }
    if (event.action_id === 'updateField' || event.action_id === 'archiveField') {
      const field = await context.db.tables.getField(id);
      return field ? baseFromTable(field.table_id) : undefined;
    }
    if (event.action_id === 'updateView') {
      const view = await context.db.tables.getView(id);
      return view ? baseFromTable(view.table_id) : undefined;
    }
    if (
      event.action_id === 'getRecord' ||
      event.action_id === 'updateRecord' ||
      event.action_id === 'deleteRecord' ||
      event.action_id === 'restoreRecord'
    ) {
      const record = await context.db.tables.getRecordById(id);
      return record ? baseFromTable(record.table_id) : undefined;
    }
    return undefined;
  };

  const events = [];
  for (const event of candidates) {
    if ((await eventBaseId(event)) === baseId) events.push(event);
    if (events.length >= limit) break;
  }
  return ok({ events });
};

const manageMembers: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const baseId = positiveInt(payload, 'baseId');
  const userId = stringValue(payload, 'userId');
  if (!baseId || !userId) return fail('INVALID_INPUT', 'baseId and userId are required');
  const access = await requireBase(context, request.actor, baseId, 'base', 'owner');
  if (!access) return fail('NOT_FOUND', 'Base not found');
  if (userId === access.base.owner_id) return fail('CONFLICT', 'The Base owner cannot be changed here');
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

const listTables: Handler = async (request, context) => {
  const baseId = positiveInt(payloadOf(request), 'baseId');
  if (!baseId) return fail('INVALID_INPUT', 'baseId is required');
  const access = await requireBase(context, request.actor, baseId, 'table', 'viewer');
  if (!access) return fail('NOT_FOUND', 'Base not found');
  return ok({ tables: await context.db.tables.listTables(baseId) });
};

const getSchema: Handler = async (request, context) => {
  const tableId = positiveInt(payloadOf(request), 'tableId');
  if (!tableId) return fail('INVALID_INPUT', 'tableId is required');
  const base = await baseForTable(context.db, tableId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'table', 'viewer'))) {
    return fail('NOT_FOUND', 'Table not found');
  }
  const schema = await context.db.tables.getSchema(tableId, effectiveUserId(request.actor));
  return schema ? ok(schema) : fail('NOT_FOUND', 'Table not found');
};

const listSchemaVersions: Handler = async (request, context) => {
  const tableId = positiveInt(payloadOf(request), 'tableId');
  if (!tableId) return fail('INVALID_INPUT', 'tableId is required');
  const base = await baseForTable(context.db, tableId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'table', 'viewer'))) {
    return fail('NOT_FOUND', 'Table not found');
  }
  return ok({ versions: await context.db.tables.listSchemaVersions(tableId) });
};

const getSchemaVersion: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const version = positiveInt(payload, 'version');
  if (!tableId || !version) return fail('INVALID_INPUT', 'tableId and version are required');
  const base = await baseForTable(context.db, tableId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'table', 'viewer'))) {
    return fail('NOT_FOUND', 'Table not found');
  }
  const snapshot = await context.db.tables.getSchemaVersion(tableId, version);
  return snapshot ? ok({ version: snapshot }) : fail('NOT_FOUND', 'Schema version not found');
};

const createTable: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const baseId = positiveInt(payload, 'baseId');
  const name = stringValue(payload, 'name');
  if (!baseId || !name) return fail('INVALID_INPUT', 'baseId and name are required');
  if (!(await requireBase(context, request.actor, baseId, 'table', 'builder'))) {
    return fail('NOT_FOUND', 'Base not found');
  }
  const schema = await context.db.tables.createTable({
    base_id: baseId,
    name,
    description: typeof payload.description === 'string' ? payload.description : undefined,
    created_by: effectiveUserId(request.actor),
  });
  return ok(schema);
};

const updateTable: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  if (!tableId) return fail('INVALID_INPUT', 'tableId is required');
  const base = await baseForTable(context.db, tableId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'table', 'builder'))) {
    return fail('NOT_FOUND', 'Table not found');
  }
  const table = await context.db.tables.updateTable(tableId, {
    name: stringValue(payload, 'name'),
    description:
      payload.description === null || typeof payload.description === 'string'
        ? (payload.description as string | null)
        : undefined,
    position: typeof payload.position === 'number' ? payload.position : undefined,
  });
  return table ? ok({ table }) : fail('NOT_FOUND', 'Table not found');
};

/**
 * Owner, not builder — deliberately asymmetric with createTable/updateTable.
 * Building a table and taking one away from everyone who reads it are not
 * symmetric acts (spec D3). Records, links and fields survive the archive.
 */
const archiveTable: Handler = async (request, context) => {
  const tableId = positiveInt(payloadOf(request), 'tableId');
  if (!tableId) return fail('INVALID_INPUT', 'tableId is required');
  const base = await baseForTable(context.db, tableId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'table', 'owner'))) {
    return fail('NOT_FOUND', 'Table not found');
  }
  const table = await context.db.tables.archiveTable(tableId);
  return table ? ok({ table }) : fail('NOT_FOUND', 'Table not found');
};

const createField: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const name = stringValue(payload, 'name');
  const type = stringValue(payload, 'type') as TableFieldType | undefined;
  if (!tableId || !name || !type) return fail('INVALID_INPUT', 'tableId, name, and type are required');
  if (!TABLE_FIELD_TYPES.includes(type)) return fail('INVALID_INPUT', `Unsupported field type "${type}"`);
  const base = await baseForTable(context.db, tableId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'field', 'builder'))) {
    return fail('NOT_FOUND', 'Table not found');
  }
  const field = await context.db.tables.createField({
    table_id: tableId,
    name,
    type,
    required: payload.required === true,
    config: objectValue<TableFieldConfig>(payload, 'config'),
    position: typeof payload.position === 'number' ? payload.position : undefined,
    created_by: effectiveUserId(request.actor),
  });
  return ok({ field });
};

const updateField: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const fieldId = positiveInt(payload, 'fieldId');
  if (!fieldId) return fail('INVALID_INPUT', 'fieldId is required');
  const base = await baseForField(context.db, fieldId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'field', 'builder'))) {
    return fail('NOT_FOUND', 'Field not found');
  }
  const field = await context.db.tables.updateField(fieldId, {
    updated_by: effectiveUserId(request.actor),
    name: stringValue(payload, 'name'),
    required: typeof payload.required === 'boolean' ? payload.required : undefined,
    config: objectValue<TableFieldConfig>(payload, 'config'),
    position: typeof payload.position === 'number' ? payload.position : undefined,
  });
  return field ? ok({ field }) : fail('NOT_FOUND', 'Field not found');
};

const archiveField: Handler = async (request, context) => {
  const fieldId = positiveInt(payloadOf(request), 'fieldId');
  if (!fieldId) return fail('INVALID_INPUT', 'fieldId is required');
  const base = await baseForField(context.db, fieldId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'field', 'builder'))) {
    return fail('NOT_FOUND', 'Field not found');
  }
  const field = await context.db.tables.archiveField(fieldId, effectiveUserId(request.actor));
  return field ? ok({ field }) : fail('CONFLICT', 'Primary or unavailable fields cannot be archived');
};

const listViews: Handler = async (request, context) => {
  const tableId = positiveInt(payloadOf(request), 'tableId');
  if (!tableId) return fail('INVALID_INPUT', 'tableId is required');
  const base = await baseForTable(context.db, tableId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'view', 'viewer'))) {
    return fail('NOT_FOUND', 'Table not found');
  }
  return ok({ views: await context.db.tables.listViews(tableId, effectiveUserId(request.actor)) });
};

const createView: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const name = stringValue(payload, 'name');
  const scope: TableViewScope = payload.scope === 'shared' ? 'shared' : 'personal';
  if (!tableId || !name) return fail('INVALID_INPUT', 'tableId and name are required');
  const base = await baseForTable(context.db, tableId);
  const required: RequiredRole = scope === 'shared' ? 'builder' : 'editor';
  if (!base || !(await requireBase(context, request.actor, base.id, 'view', required))) {
    return fail('NOT_FOUND', 'Table not found');
  }
  const view = await context.db.tables.createView({
    table_id: tableId,
    name,
    scope,
    owner_id: scope === 'personal' ? effectiveUserId(request.actor) : null,
    config: objectValue<TableViewConfig>(payload, 'config'),
    created_by: effectiveUserId(request.actor),
  });
  return ok({ view });
};

const updateView: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const viewId = positiveInt(payload, 'viewId');
  const revision = positiveInt(payload, 'revision');
  if (!viewId || !revision) return fail('INVALID_INPUT', 'viewId and revision are required');
  const userId = effectiveUserId(request.actor);
  const view = await context.db.tables.getView(viewId, userId);
  const base = await baseForView(context.db, viewId);
  if (!view || !base) return fail('NOT_FOUND', 'View not found');
  const required: RequiredRole = view.scope === 'personal' && view.owner_id === userId ? 'editor' : 'builder';
  if (!(await requireBase(context, request.actor, base.id, 'view', required))) {
    return fail('NOT_FOUND', 'View not found');
  }
  const updated = await context.db.tables.updateView(
    viewId,
    {
      revision,
      name: stringValue(payload, 'name'),
      config: objectValue<TableViewConfig>(payload, 'config'),
      position: typeof payload.position === 'number' ? payload.position : undefined,
    },
    userId,
  );
  if (updated.ok) return ok({ view: updated.value });
  return updated.reason === 'conflict'
    ? fail('CONFLICT', 'View revision conflict', { currentRevision: updated.current })
    : fail('NOT_FOUND', 'View not found');
};

async function requireTableData(
  request: Parameters<Handler>[0],
  context: PlatformHandlerContext,
  tableId: number,
  required: RequiredRole,
  valuesAccess: 'none' | 'read' | 'full-read' | 'write' = 'none',
): Promise<{ base: TableBaseRow; valuesRead: 'none' | 'masked' | 'full' } | undefined> {
  const base = await baseForTable(context.db, tableId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'record', required))) return undefined;
  const policy = await entityPolicy(context, request.actor, 'record');
  const values = fieldPolicyFor(policy, 'values');
  if (valuesAccess === 'write' && !values.write) return undefined;
  if (valuesAccess === 'read' && values.read === 'none') return undefined;
  if (valuesAccess === 'full-read' && values.read !== 'full') return undefined;
  return { base, valuesRead: values.read };
}

const getRecord: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const recordId = positiveInt(payload, 'recordId');
  if (!tableId || !recordId) return fail('INVALID_INPUT', 'tableId and recordId are required');
  const access = await requireTableData(request, context, tableId, 'viewer', 'read');
  if (!access) return fail('NOT_FOUND', 'Record not found');
  const record = await context.db.tables.getRecord(tableId, recordId);
  return record
    ? ok({ record: access.valuesRead === 'masked' ? { ...record, values: {} } : record })
    : fail('NOT_FOUND', 'Record not found');
};

const queryRecords: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  if (!tableId) return fail('INVALID_INPUT', 'tableId is required');
  if (!(await requireTableData(request, context, tableId, 'viewer', 'full-read'))) {
    return fail('NOT_FOUND', 'Table not found');
  }
  return ok(await context.db.tables.queryRecords(tableId, objectValue<TableQuery>(payload, 'query') ?? {}));
};

const aggregateRecords: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const input = objectValue<TableAggregateInput>(payload, 'input');
  if (!tableId || !input) return fail('INVALID_INPUT', 'tableId and input are required');
  if (!(await requireTableData(request, context, tableId, 'viewer', 'full-read'))) {
    return fail('NOT_FOUND', 'Table not found');
  }
  return ok({ rows: await context.db.tables.aggregateRecords(tableId, input) });
};

const createRecord: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const values = objectValue<TableRecordValues>(payload, 'values');
  if (!tableId || !values) return fail('INVALID_INPUT', 'tableId and values are required');
  if (!(await requireTableData(request, context, tableId, 'editor', 'write'))) {
    return fail('NOT_FOUND', 'Table not found');
  }
  const record = await context.db.tables.createRecord({
    table_id: tableId,
    values,
    user_id: effectiveUserId(request.actor),
  });
  return ok({ record });
};

const updateRecord: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const recordId = positiveInt(payload, 'recordId');
  const revision = positiveInt(payload, 'revision');
  const values = objectValue<TableRecordValues>(payload, 'values');
  if (!tableId || !recordId || !revision || !values) {
    return fail('INVALID_INPUT', 'tableId, recordId, revision, and values are required');
  }
  if (!(await requireTableData(request, context, tableId, 'editor', 'write'))) {
    return fail('NOT_FOUND', 'Record not found');
  }
  const result = await context.db.tables.updateRecord({
    table_id: tableId,
    record_id: recordId,
    revision,
    values,
    user_id: effectiveUserId(request.actor),
  });
  if (result.ok) return ok({ record: result.record });
  return result.reason === 'conflict'
    ? fail('CONFLICT', 'Record revision conflict', { currentRevision: result.current })
    : fail('NOT_FOUND', 'Record not found');
};

const batchUpsertRecords: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  if (!tableId || !Array.isArray(payload.items)) return fail('INVALID_INPUT', 'tableId and items are required');
  if (!(await requireTableData(request, context, tableId, 'editor', 'write'))) {
    return fail('NOT_FOUND', 'Table not found');
  }
  const results = await context.db.tables.batchUpsertRecords({
    table_id: tableId,
    items: payload.items as Array<{ record_id?: number; revision?: number; values: TableRecordValues }>,
    user_id: effectiveUserId(request.actor),
  });
  return ok({ results });
};

const validateBatchRecords: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  if (!tableId || !Array.isArray(payload.items)) return fail('INVALID_INPUT', 'tableId and items are required');
  if (!(await requireTableData(request, context, tableId, 'editor', 'write'))) {
    return fail('NOT_FOUND', 'Table not found');
  }
  const results = await context.db.tables.validateBatchRecords({
    table_id: tableId,
    items: payload.items as Array<{ record_id?: number; revision?: number; values: TableRecordValues }>,
  });
  return ok({ results });
};

const deleteRecord: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const recordId = positiveInt(payload, 'recordId');
  const revision = positiveInt(payload, 'revision');
  if (!tableId || !recordId || !revision) {
    return fail('INVALID_INPUT', 'tableId, recordId, and revision are required');
  }
  if (!(await requireTableData(request, context, tableId, 'editor', 'full-read'))) {
    return fail('NOT_FOUND', 'Record not found');
  }
  const result = await context.db.tables.deleteRecord({
    table_id: tableId,
    record_id: recordId,
    revision,
    user_id: effectiveUserId(request.actor),
  });
  if (result.ok) return ok({ record: result.record });
  return result.reason === 'conflict'
    ? fail('CONFLICT', 'Record revision conflict', { currentRevision: result.current })
    : fail('NOT_FOUND', 'Record not found');
};

const listDeletedRecords: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  if (!tableId) return fail('INVALID_INPUT', 'tableId is required');
  if (!(await requireTableData(request, context, tableId, 'editor', 'full-read'))) {
    return fail('NOT_FOUND', 'Table not found');
  }
  const records = await context.db.tables.listDeletedRecords(tableId, positiveInt(payload, 'limit') ?? 100);
  return ok({ records });
};

const restoreRecord: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const recordId = positiveInt(payload, 'recordId');
  if (!tableId || !recordId) return fail('INVALID_INPUT', 'tableId and recordId are required');
  if (!(await requireTableData(request, context, tableId, 'editor', 'full-read'))) {
    return fail('NOT_FOUND', 'Record not found');
  }
  const result = await context.db.tables.restoreRecord({
    table_id: tableId,
    record_id: recordId,
    user_id: effectiveUserId(request.actor),
  });
  return result.ok ? ok({ record: result.record }) : fail('NOT_FOUND', 'Record not found');
};

const handlers = {
  listBases,
  getBase,
  createBase,
  updateBase,
  archiveBase,
  listMembers,
  listBaseAudit,
  manageMembers,
  listAssignableUsers,
  listTables,
  getSchema,
  listSchemaVersions,
  getSchemaVersion,
  createTable,
  updateTable,
  archiveTable,
  createField,
  updateField,
  archiveField,
  listViews,
  createView,
  updateView,
  getRecord,
  queryRecords,
  aggregateRecords,
  createRecord,
  updateRecord,
  validateBatchRecords,
  batchUpsertRecords,
  deleteRecord,
  listDeletedRecords,
  restoreRecord,
};

export const tablesRegistration: ApplicationRegistration<PlatformHandlerContext> = {
  manifest: tablesManifest,
  handlers: Object.fromEntries(Object.entries(handlers).map(([id, handler]) => [id, wrap(handler)])),
};

export function tablesResource(
  actionId: TablesActionId,
  ids: {
    baseId?: number;
    tableId?: number;
    fieldId?: number;
    viewId?: number;
    recordId?: number;
  } = {},
) {
  const action = tablesManifest.actions[actionId];
  const id = ids.recordId ?? ids.viewId ?? ids.fieldId ?? ids.tableId ?? ids.baseId;
  return {
    appId: tablesManifest.id,
    moduleId: action.module,
    entityId: action.entity,
    recordId: id ? String(id) : undefined,
  };
}
