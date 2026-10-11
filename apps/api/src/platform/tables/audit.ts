/**
 * Tables audit resources — one map, both directions.
 *
 * `TABLES_ACTION_RESOURCES` says which resource every action is audited
 * against. `tablesResource()` stamps that id into the dispatch's resource;
 * before the handler runs, `tablesAuditScope()` (the registration's
 * `auditScope`, called by `runtime.dispatch`) resolves the Base that resource
 * belongs to and files the event under `scope_type = 'base'` / `scope_id` —
 * before, because a delete leaves nothing to resolve afterwards. App actions
 * are audited against the app (`entity_id = 'app'`, `record_id` = the app id)
 * and filed under its Base. `listBaseAudit` is then one indexed read of the
 * Base's write events. The map is keyed by `TablesActionId`, so a new action
 * that is not placed here fails typecheck.
 */

import type { PlatformActionRequest } from '@greenhouse/platform-kernel';
import type { DatabaseProvider, TablesResourceKind } from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
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
  // Apps — every app action is audited against the app (usage counts read it back)
  listApps: null,
  createApp: 'base',
  getApp: 'app',
  updateApp: 'app',
  getAppDraft: 'app',
  saveAppDraft: 'app',
  publishApp: 'app',
  listAppVersions: 'app',
  restoreAppVersion: 'app',
  listAppAudiences: 'app',
  setAppAudiences: 'app',
  transferApp: 'app',
  archiveApp: 'app',
  featureApp: 'app',
  queryAppCard: 'app',
  getAppRecord: 'app',
  runAppAction: 'app',
  listAppActivity: 'app',
  createAppComment: 'app',
  updateAppComment: 'app',
  deleteAppComment: 'app',
  listAppFieldOptions: 'app',
  uploadAppFile: 'app',
  getAppFile: 'app',
  getAppUsage: 'app',
  listAppPins: null,
  setAppPins: null,
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
 * The Base a dispatch's resource belongs to — `runtime.dispatch` calls this
 * before the handler and files the audit event under it. Undefined for
 * actions not tied to one Base, unknown ids, or when the lookup fails (the
 * action still runs; it just stays out of the Base feed).
 */
export async function tablesAuditScope(
  db: DatabaseProvider,
  request: Pick<PlatformActionRequest, 'actionId' | 'resource'>,
): Promise<{ scopeType: 'base'; scopeId: string } | undefined> {
  const kind = resourceKindOf(request.actionId);
  const id = Number(request.resource?.recordId);
  if (!kind || !Number.isInteger(id) || id <= 0) return undefined;
  try {
    const baseId = (await db.tables.baseIdsForResources(kind, [id])).get(id);
    return baseId ? { scopeType: 'base', scopeId: String(baseId) } : undefined;
  } catch (error) {
    logger.warn('[tables] audit scope lookup failed', { actionId: request.actionId, error: toErrorMessage(error) });
    return undefined;
  }
}

/** The write actions — what a Base's audit feed lists (reads would drown them: an app reads constantly). */
const WRITE_ACTION_IDS: readonly string[] = Object.values(tablesManifest.actions)
  .filter((action) => action.kind === 'command')
  .map((action) => action.id);

/**
 * The Base owner's audit feed: the newest write events filed under this Base
 * (`scope_type = 'base'`), one indexed read — reads are excluded, so no amount
 * of app traffic can push a write out of the window.
 */
export const listBaseAudit: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const baseId = positiveInt(payload, 'baseId');
  if (!baseId) return fail('INVALID_INPUT', 'baseId is required');
  if (!(await requireBase(context, request.actor, baseId, 'base', 'owner'))) {
    return fail('NOT_FOUND', 'Base not found');
  }
  const events = await context.db.platform.listAuditEventsByScope({
    orgId: request.actor.orgId,
    appId: tablesManifest.id,
    scopeType: 'base',
    scopeId: String(baseId),
    actionIds: WRITE_ACTION_IDS,
    limit: Math.min(positiveInt(payload, 'limit') ?? 100, 200),
  });
  return ok({ events });
};
