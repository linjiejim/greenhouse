/**
 * Saved views. Shared views need builder; a personal view is its owner's
 * (editor+), and the db service enforces privacy by user id. View types,
 * config validation and `deleteView` arrive with slice V.
 */

import { effectiveUserId } from '@greenhouse/platform-kernel';
import type { TableBaseRole, TableViewConfig, TableViewScope } from '@greenhouse/types/tables';
import { baseForTable, baseForView, requireBase } from '../access.js';
import {
  fail,
  notImplemented,
  objectValue,
  ok,
  optionalNumber,
  payloadOf,
  positiveInt,
  stringValue,
  type Handler,
  type TablesHandlers,
} from './shared.js';

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
  const required: TableBaseRole = scope === 'shared' ? 'builder' : 'editor';
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
  const required: TableBaseRole = view.scope === 'personal' && view.owner_id === userId ? 'editor' : 'builder';
  if (!(await requireBase(context, request.actor, base.id, 'view', required))) {
    return fail('NOT_FOUND', 'View not found');
  }
  const updated = await context.db.tables.updateView(
    viewId,
    {
      revision,
      name: stringValue(payload, 'name'),
      config: objectValue<TableViewConfig>(payload, 'config'),
      position: optionalNumber(payload, 'position'),
    },
    userId,
  );
  if (updated.ok) return ok({ view: updated.value });
  return updated.reason === 'conflict'
    ? fail('CONFLICT', 'View revision conflict', { currentRevision: updated.current })
    : fail('NOT_FOUND', 'View not found');
};

export const viewHandlers = {
  listViews,
  createView,
  updateView,
  // Slice V.
  deleteView: notImplemented,
} satisfies TablesHandlers;
