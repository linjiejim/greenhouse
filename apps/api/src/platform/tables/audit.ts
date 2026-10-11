/**
 * Tables audit resources — one map, both directions.
 *
 * `TABLES_ACTION_RESOURCES` says which resource every action is audited
 * against. `tablesResource()` (forward, at dispatch) stamps that id into the
 * platform audit event; `listBaseAudit` (reverse) reads it back and asks the db
 * which Base owns it. Both read the same map, and the map is keyed by
 * `TablesActionId`, so a new action that is not placed here fails typecheck —
 * it can no longer silently vanish from the Base audit feed.
 */

import type { TablesResourceKind } from '@greenhouse/db';
import { tablesManifest, type TablesActionId } from '../manifests/tables.js';
import { requireBase } from './access.js';
import { fail, ok, payloadOf, positiveInt, type Handler } from './handlers/shared.js';

/** `null` = not tied to one Base (listing, creating a Base, the user directory). */
export const TABLES_ACTION_RESOURCES: Readonly<Record<TablesActionId, TablesResourceKind | null>> = {
  // Bases, members, roles
  listBases: null,
  getBase: 'base',
  createBase: null,
  updateBase: 'base',
  archiveBase: 'base',
  listMembers: 'base',
  listBaseAudit: 'base',
  manageMembers: 'base',
  transferBaseOwner: 'base',
  listAssignableUsers: null,
  listRoles: 'base',
  createRole: 'base',
  updateRole: 'role',
  deleteRole: 'role',
  // Schema
  listTables: 'base',
  getSchema: 'table',
  listSchemaVersions: 'table',
  getSchemaVersion: 'table',
  createTable: 'base',
  updateTable: 'table',
  archiveTable: 'table',
  createField: 'table',
  updateField: 'field',
  archiveField: 'field',
  // Views and forms
  listViews: 'table',
  createView: 'table',
  updateView: 'view',
  deleteView: 'view',
  listForms: 'table',
  getForm: 'form',
  createForm: 'table',
  updateForm: 'form',
  openForm: 'form',
  submitForm: 'form',
  // Records
  getRecord: 'record',
  queryRecords: 'table',
  aggregateRecords: 'table',
  createRecord: 'table',
  updateRecord: 'record',
  batchUpsertRecords: 'table',
  validateBatchRecords: 'table',
  deleteRecord: 'record',
  listDeletedRecords: 'table',
  restoreRecord: 'record',
  // Activity and comments
  listRecordActivity: 'record',
  createComment: 'record',
  updateComment: 'comment',
  deleteComment: 'comment',
  // Import
  previewImport: 'table',
  commitImport: 'table',
  // Automations
  listAutomations: 'base',
  createAutomation: 'base',
  updateAutomation: 'automation',
  listAutomationRuns: 'automation',
  deleteAutomation: 'automation',
  triggerAutomation: 'record',
  listRecordButtons: 'record',
  // Dashboards
  listDashboards: 'base',
  getDashboard: 'dashboard',
  createDashboard: 'base',
  updateDashboard: 'dashboard',
  deleteDashboard: 'dashboard',
  createDashboardWidget: 'dashboard',
  updateDashboardWidget: 'widget',
  deleteDashboardWidget: 'widget',
  queryDashboardWidget: 'widget',
};

/** The ids a caller can name; each action reads only the one its resource kind points at. */
export interface TablesResourceIds {
  baseId?: number;
  tableId?: number;
  fieldId?: number;
  viewId?: number;
  formId?: number;
  recordId?: number;
  automationId?: number;
  dashboardId?: number;
  widgetId?: number;
  roleId?: number;
  commentId?: number;
  appId?: number;
}

const ID_KEY: Readonly<Record<TablesResourceKind, keyof TablesResourceIds>> = {
  base: 'baseId',
  table: 'tableId',
  field: 'fieldId',
  view: 'viewId',
  form: 'formId',
  record: 'recordId',
  automation: 'automationId',
  dashboard: 'dashboardId',
  widget: 'widgetId',
  role: 'roleId',
  comment: 'commentId',
  app: 'appId',
};

/** The audit resource of one dispatch. */
export function tablesResource(actionId: TablesActionId, ids: TablesResourceIds = {}) {
  const action = tablesManifest.actions[actionId]!;
  const kind = TABLES_ACTION_RESOURCES[actionId];
  const id = kind ? ids[ID_KEY[kind]] : undefined;
  return {
    appId: tablesManifest.id,
    moduleId: action.module,
    entityId: action.entity,
    recordId: id ? String(id) : undefined,
  };
}

function resourceKindOf(actionId: string): TablesResourceKind | null {
  return Object.hasOwn(TABLES_ACTION_RESOURCES, actionId) ? TABLES_ACTION_RESOURCES[actionId as TablesActionId] : null;
}

/**
 * The Base owner's audit feed: the newest platform audit events of the Tables
 * app whose resource belongs to this Base. Scans `limit × 4` (≤ 500) events and
 * resolves each kind's ids to Bases in one query per kind.
 */
export const listBaseAudit: Handler = async (request, context) => {
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

  const idsByKind = new Map<TablesResourceKind, number[]>();
  const located = candidates.map((event) => {
    const kind = resourceKindOf(event.action_id);
    const id = Number(event.record_id);
    if (!kind || !Number.isInteger(id) || id <= 0) return undefined;
    idsByKind.set(kind, [...(idsByKind.get(kind) ?? []), id]);
    return { kind, id };
  });
  const baseByKind = new Map<TablesResourceKind, Map<number, number>>();
  await Promise.all(
    [...idsByKind].map(async ([kind, ids]) => {
      baseByKind.set(kind, await context.db.tables.baseIdsForResources(kind, ids));
    }),
  );

  const events = candidates
    .filter((_event, index) => {
      const at = located[index];
      return at !== undefined && baseByKind.get(at.kind)?.get(at.id) === baseId;
    })
    .slice(0, limit);
  return ok({ events });
};
