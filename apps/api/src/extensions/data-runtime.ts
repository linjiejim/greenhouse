import { sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { createTableCrudService, type DatabaseProvider } from '@greenhouse/db';
import {
  canAccessRecord,
  effectiveUserId,
  fieldPolicyFor,
  resolveEntityPolicy,
  projectReadableFields,
  type ActorContext,
  type EntityDefinition,
  type PlatformActionResult,
} from '@greenhouse/platform-kernel';
import { validateListParams, type ListContract, type ListParams, type ListResult } from '@greenhouse/crud/server';
import { getPlatformRuntime } from '../platform/runtime.js';
import type { DataEntity, DataHandlerContext, DataRow, ExtensionDataSource } from './data-types.js';
import { dataWritableFields } from './data-fields.js';

export const dataActionId = (entity: string, action: string) => `${entity}${action[0].toUpperCase()}${action.slice(1)}`;
export function dataListContract(entity: EntityDefinition): ListContract {
  return {
    filterable: Object.fromEntries(
      Object.entries(entity.fields)
        .filter(([, f]) => f.filterable)
        .map(([key, f]) => [
          key,
          { type: ['integer', 'decimal'].includes(f.kind) ? 'number' : f.kind === 'boolean' ? 'boolean' : 'text' },
        ]),
    ),
    sortable: Object.keys(entity.fields).filter((key) => entity.fields[key].sortable),
    maxLimit: 1000,
  };
}
export async function dataContext(
  db: DatabaseProvider,
  actor: ActorContext,
  source: ExtensionDataSource,
  entityId: string,
): Promise<DataHandlerContext> {
  const entity = source.app.entities[entityId],
    config = source.entities[entityId];
  const snapshot = await db.platform.getEntityPolicySnapshot({
    userId: effectiveUserId(actor),
    appId: source.app.id,
    entityId,
  });
  const policy = resolveEntityPolicy(snapshot.rolePolicies);
  const columns = Object.fromEntries(Object.keys(entity.fields).map((key) => [key, config.columns?.[key] ?? key]));
  const userId = effectiveUserId(actor);
  const scopes = policy.scopes.map((scope) => {
    if (scope.kind === 'all') return sql`true`;
    if (scope.kind === 'own' && config.ownerField)
      return sql`${sql.identifier(columns[config.ownerField])} = ${userId}`;
    if (scope.kind === 'collaborating' && config.memberField)
      return sql`${sql.identifier(columns[config.memberField])}::jsonb @> ${JSON.stringify([userId])}::jsonb`;
    return sql`false`;
  });
  const scope = scopes.length ? sql`(${sql.join(scopes, sql` OR `)})` : sql`false`;
  return {
    db,
    actor,
    policy,
    service: createTableCrudService(db, entity.table, {
      columns,
      scope,
      jsonFields: Object.keys(entity.fields).filter((key) =>
        ['users', 'relations', 'json'].includes(entity.fields[key].kind),
      ),
      searchFields: Object.keys(entity.fields).filter(
        (key) => entity.fields[key].searchable && fieldPolicyFor(policy, key).read === 'full',
      ),
    }),
  };
}
export function dataCanAccess(row: DataRow, ctx: DataHandlerContext, config: DataEntity): boolean {
  return canAccessRecord(
    ctx.actor,
    {
      ownerId: config.ownerField ? String(row[config.ownerField]) : undefined,
      collaboratorIds:
        config.memberField && Array.isArray(row[config.memberField]) ? (row[config.memberField] as string[]) : [],
    },
    ctx.policy,
  );
}
export function dataProject(row: DataRow, ctx: DataHandlerContext, action: 'read' | 'export' = 'read'): DataRow {
  const permitted =
    action === 'export'
      ? Object.fromEntries(
          Object.entries(row).filter(
            ([key]) => fieldPolicyFor(ctx.policy, key).export && fieldPolicyFor(ctx.policy, key).read === 'full',
          ),
        )
      : row;
  return projectReadableFields(permitted, ctx.policy, () => '***');
}

export interface DataOperation {
  action: 'list' | 'get' | 'search' | 'aggregate' | 'export' | 'create' | 'update' | 'delete';
  id?: string;
  data?: DataRow;
  params?: ListParams;
  query?: string;
  /** Catalog discovery can authorize without scanning/counting records. */
  counts?: boolean;
}
export async function executeDataOperation(
  source: ExtensionDataSource,
  entityId: string,
  operation: DataOperation,
  db: DatabaseProvider,
  actor: ActorContext,
): Promise<unknown> {
  const entity = source.app.entities[entityId],
    config = source.entities[entityId];
  if (!entity || !config) throw new HTTPException(400, { message: 'Unknown entity' });
  if (
    ['get', 'update', 'delete'].includes(operation.action) &&
    (!operation.id || (entity.fields.id?.kind === 'integer' && !/^[1-9][0-9]*$/.test(operation.id)))
  )
    throw new HTTPException(400, { message: 'Invalid or missing record id' });
  const action = ['list', 'get', 'search', 'aggregate'].includes(operation.action) ? 'read' : operation.action;
  if (!config.actions[action as keyof typeof config.actions])
    throw new HTTPException(403, { message: `Action ${action} is disabled` });
  const runtime = getPlatformRuntime();
  const result = await runtime.dispatch(
    {
      actor,
      appId: source.app.id,
      actionId: dataActionId(entityId, action),
      resource: { appId: source.app.id, moduleId: entity.module, entityId, recordId: operation.id },
      payload: operation,
    },
    () => runDataOperation(source, entityId, operation, db, actor),
  );
  if (!result.ok)
    throw new HTTPException(
      result.code === 'FORBIDDEN'
        ? 403
        : result.code === 'NOT_FOUND'
          ? 404
          : result.code === 'INVALID_INPUT'
            ? 400
            : 500,
      { message: result.message },
    );
  return result.data;
}

/** Default registered handlers and transport-bound calls share this guarded operation body. */
export async function runDataOperation(
  source: ExtensionDataSource,
  entityId: string,
  operation: DataOperation,
  db: DatabaseProvider,
  actor: ActorContext,
): Promise<PlatformActionResult> {
  const entity = source.app.entities[entityId],
    config = source.entities[entityId];
  if (source.featureFlag) {
    const { userHasFeature } = await import('../auth/features.js');
    const user = await db.users.getById(effectiveUserId(actor));
    if (!user || !(await userHasFeature(user.id, user.role, source.featureFlag, db)))
      return { ok: false, code: 'FORBIDDEN', message: 'Feature unavailable' };
  }
  const ctx = await dataContext(db, actor, source, entityId);
  if (!ctx.policy.scopes.length) return { ok: false, code: 'FORBIDDEN', message: 'No entity scope is granted' };
  const access = (row: DataRow) => dataCanAccess(row, ctx, config);
  const handlers = config.handlers ?? {};
  const get = (id: string) => (handlers.get ? handlers.get(id, ctx) : ctx.service.get(id));
  const project = (row: DataRow) => dataProject(row, ctx, operation.action === 'export' ? 'export' : 'read');
  const parsed = validateListParams(operation.params ?? {}, dataListContract(entity));
  if (!parsed.ok) return { ok: false, code: 'INVALID_INPUT', message: parsed.error };
  for (const key of [
    ...(parsed.params.filter ?? []).map((f) => f.key),
    ...(parsed.params.sort ?? []).map((s) => s.key),
  ]) {
    if (fieldPolicyFor(ctx.policy, key).read !== 'full')
      return { ok: false, code: 'FORBIDDEN', message: `Field ${key} cannot be queried` };
  }
  if (operation.action === 'aggregate' && operation.counts === false) return { ok: true, data: { count: null } };
  if (['list', 'search', 'aggregate', 'export'].includes(operation.action)) {
    let rows: ListResult<DataRow>;
    if (operation.action === 'search')
      rows = handlers.search
        ? await handlers.search(operation.query ?? '', parsed.params, ctx)
        : await ctx.service.search(operation.query ?? '', parsed.params);
    else if (operation.action === 'export' && handlers.export) rows = await handlers.export(parsed.params, ctx);
    else rows = handlers.list ? await handlers.list(parsed.params, ctx) : await ctx.service.list(parsed.params);
    if (rows.items.some((row) => !access(row)))
      return { ok: false, code: 'FORBIDDEN', message: 'Handler returned records outside the member scope' };
    return {
      ok: true,
      data: operation.action === 'aggregate' ? { count: rows.total } : { ...rows, items: rows.items.map(project) },
    };
  }
  if (operation.action === 'create' || operation.action === 'update') {
    if (
      operation.data === null ||
      (operation.data !== undefined && (typeof operation.data !== 'object' || Array.isArray(operation.data)))
    )
      return { ok: false, code: 'INVALID_INPUT', message: 'Expected a data object' };
    const data = { ...(operation.data ?? {}) };
    const writable = new Set(dataWritableFields(entity, config, ctx.policy));
    const forbidden = Object.keys(data).filter((key) => !writable.has(key));
    if (forbidden.length)
      return { ok: false, code: 'INVALID_INPUT', message: `Unknown or non-writable fields: ${forbidden.join(', ')}` };
    for (const [key, value] of Object.entries(data)) {
      const field = entity.fields[key];
      const valid =
        value === null
          ? !field.required
          : ['integer', 'decimal'].includes(field.kind)
            ? typeof value === 'number' &&
              Number.isFinite(value) &&
              (field.kind !== 'integer' || Number.isInteger(value))
            : field.kind === 'boolean'
              ? typeof value === 'boolean'
              : ['json', 'users', 'relations'].includes(field.kind)
                ? field.kind === 'json' || Array.isArray(value)
                : typeof value === 'string' && (field.kind !== 'enum' || field.values?.includes(value));
      if (!valid) return { ok: false, code: 'INVALID_INPUT', message: `Invalid field: ${key}` };
    }
    if (operation.action === 'create') {
      // Validate caller input first; ownership is trusted host data, independent of field grants.
      if (config.ownerField) data[config.ownerField] = effectiveUserId(actor);
      if (!dataCanAccess(data, ctx, config))
        return { ok: false, code: 'FORBIDDEN', message: 'Cannot create outside the member scope' };
      for (const [key, field] of Object.entries(entity.fields))
        if (field.required && writable.has(key) && data[key] == null)
          return { ok: false, code: 'INVALID_INPUT', message: `Missing field: ${key}` };
      const row = handlers.create ? await handlers.create(data, ctx) : await ctx.service.create(data);
      if (!access(row))
        return { ok: false, code: 'FORBIDDEN', message: 'Handler created a record outside the member scope' };
      return { ok: true, data: project(row), audit: { recordId: String(row.id) } };
    }
    const existing = operation.id ? await get(operation.id) : null;
    if (!existing || !access(existing)) return { ok: false, code: 'NOT_FOUND', message: 'Not found' };
    if (!access({ ...existing, ...data }))
      return { ok: false, code: 'FORBIDDEN', message: 'Cannot move a record outside the member scope' };
    const row = handlers.update
      ? await handlers.update(operation.id!, data, ctx)
      : await ctx.service.update(operation.id!, data);
    return row && access(row)
      ? { ok: true, data: project(row) }
      : { ok: false, code: 'NOT_FOUND', message: 'Not found' };
  }
  const row = operation.id ? await get(operation.id) : null;
  if (!row || !access(row)) return { ok: false, code: 'NOT_FOUND', message: 'Not found' };
  if (operation.action === 'get') return { ok: true, data: project(row) };
  const removed = handlers.delete ? await handlers.delete(operation.id!, ctx) : await ctx.service.remove(operation.id!);
  return removed ? { ok: true, data: true } : { ok: false, code: 'NOT_FOUND', message: 'Not found' };
}
