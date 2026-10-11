/**
 * Saved views — grid, kanban, calendar, gallery.
 *
 * Who may change a view:
 * - a shared view: Base builder;
 * - your own personal view: Base editor+, or a custom role that can read the
 *   view's table (spec action table: `deleteView`, and the same rule for
 *   create / update so a custom role can keep the views it may delete).
 * Someone else's personal view is invisible (the db service filters by user),
 * so every refusal answers 404.
 *
 * The config is validated by `db.tables` (`normalizeViewConfig`) against the
 * fields the author may read: a built-in role passes full access, a custom
 * role its compiled scope, so a personal view cannot reference a hidden field.
 */

import { effectiveUserId } from '@greenhouse/platform-kernel';
import {
  TABLE_VIEW_TYPES,
  type TableViewConfig,
  type TableViewScope,
  type TableViewType,
} from '@greenhouse/types/tables';
import { fullTableAccess, tableRoleAtLeast, type TableAccessScope } from '@greenhouse/types/table-access';
import { baseForTable, requireBase, requireTableData } from '../access.js';
import {
  fail,
  objectValue,
  ok,
  optionalNumber,
  payloadOf,
  positiveInt,
  stringValue,
  type Handler,
  type HandlerRequest,
  type TablesHandlers,
} from './shared.js';

type HandlerContext = Parameters<Handler>[1];

/** `undefined` = not given; `null` = given but not a view type. */
function viewTypeOf(payload: Record<string, unknown>): TableViewType | null | undefined {
  const value = payload.type;
  if (value === undefined) return undefined;
  return typeof value === 'string' && (TABLE_VIEW_TYPES as readonly string[]).includes(value)
    ? (value as TableViewType)
    : null;
}

/**
 * The scope the actor writes a view with, or undefined (answer 404). Shared:
 * builder. Own personal: editor+, or a custom role whose rules read the table.
 */
async function viewWriteScope(
  request: HandlerRequest,
  context: HandlerContext,
  tableId: number,
  scope: TableViewScope,
): Promise<TableAccessScope | undefined> {
  const userId = effectiveUserId(request.actor);
  const base = await baseForTable(context.db, tableId);
  if (!base) return undefined;
  if (scope === 'shared') {
    return (await requireBase(context, request.actor, base.id, 'view', 'builder'))
      ? fullTableAccess(userId)
      : undefined;
  }
  const grant = await requireBase(context, request.actor, base.id, 'view', 'viewer', { allowCustom: true });
  if (!grant) return undefined;
  if (grant.access.level === 'custom') {
    const data = await requireTableData(request, context, tableId, 'read', { allowMaskedValues: true });
    return data?.scope;
  }
  return grant.access.level !== 'none' && tableRoleAtLeast(grant.access.level, 'editor')
    ? fullTableAccess(userId)
    : undefined;
}

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
  const type = viewTypeOf(payload);
  const scope: TableViewScope = payload.scope === 'shared' ? 'shared' : 'personal';
  if (!tableId || !name) return fail('INVALID_INPUT', 'tableId and name are required');
  if (type === null) return fail('INVALID_INPUT', `type must be ${TABLE_VIEW_TYPES.join(' / ')}`);
  const access = await viewWriteScope(request, context, tableId, scope);
  if (!access) return fail('NOT_FOUND', 'Table not found');
  const userId = effectiveUserId(request.actor);
  const view = await context.db.tables.createView(
    {
      table_id: tableId,
      name,
      type,
      scope,
      owner_id: scope === 'personal' ? userId : null,
      config: objectValue<TableViewConfig>(payload, 'config'),
      created_by: userId,
    },
    access,
  );
  return ok({ view });
};

const updateView: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const viewId = positiveInt(payload, 'viewId');
  const revision = positiveInt(payload, 'revision');
  const type = viewTypeOf(payload);
  if (!viewId || !revision) return fail('INVALID_INPUT', 'viewId and revision are required');
  if (type === null) return fail('INVALID_INPUT', `type must be ${TABLE_VIEW_TYPES.join(' / ')}`);
  const userId = effectiveUserId(request.actor);
  const view = await context.db.tables.getView(viewId, userId);
  if (!view) return fail('NOT_FOUND', 'View not found');
  const access = await viewWriteScope(request, context, view.table_id, view.scope);
  if (!access) return fail('NOT_FOUND', 'View not found');
  const updated = await context.db.tables.updateView(
    viewId,
    {
      revision,
      name: stringValue(payload, 'name'),
      type,
      config: objectValue<TableViewConfig>(payload, 'config'),
      position: optionalNumber(payload, 'position'),
    },
    userId,
    access,
  );
  if (updated.ok) return ok({ view: updated.value });
  return updated.reason === 'conflict'
    ? fail('CONFLICT', 'View revision conflict', { currentRevision: updated.current })
    : fail('NOT_FOUND', 'View not found');
};

const deleteView: Handler = async (request, context) => {
  const viewId = positiveInt(payloadOf(request), 'viewId');
  if (!viewId) return fail('INVALID_INPUT', 'viewId is required');
  const userId = effectiveUserId(request.actor);
  const view = await context.db.tables.getView(viewId, userId);
  if (!view || !(await viewWriteScope(request, context, view.table_id, view.scope))) {
    return fail('NOT_FOUND', 'View not found');
  }
  const deleted = await context.db.tables.deleteView(viewId, userId);
  return deleted ? ok({ view: deleted }) : fail('NOT_FOUND', 'View not found');
};

export const viewHandlers = {
  listViews,
  createView,
  updateView,
  deleteView,
} satisfies TablesHandlers;
