/**
 * Tables routes — /api/tables (Platform Kernel adapter)
 *
 * GET    /bases                                      — 可见 Base
 * POST   /bases                                      — 创建 Base + 默认 Table
 * GET    /bases/:baseId                              — Base 工作区
 * PATCH  /bases/:baseId                              — 更新 Base
 * POST   /bases/:baseId/archive                      — 归档 Base
 * GET    /bases/:baseId/members                      — 成员列表
 * GET    /bases/:baseId/audit                        — Base 操作审计
 * PUT    /bases/:baseId/members/:userId              — 添加/更新成员
 * DELETE /bases/:baseId/members/:userId              — 移除成员
 * GET    /meta/users                                  — 可选内部成员
 * GET    /bases/:baseId/tables                       — Table 列表
 * POST   /bases/:baseId/tables                       — 创建 Table
 * PATCH  /tables/:tableId                            — 更新 Table
 * POST   /tables/:tableId/archive                    — 归档 Table（仅 owner，可由 CLI 恢复）
 * GET    /tables/:tableId/schema                     — 字段与视图 schema
 * GET    /tables/:tableId/schema/versions            — Schema 版本列表
 * GET    /tables/:tableId/schema/versions/:version   — Schema 快照
 * POST   /tables/:tableId/fields                     — 创建字段
 * PATCH  /fields/:fieldId                            — 更新字段
 * POST   /fields/:fieldId/archive                    — 归档字段
 * POST   /schema-plan/apply                          — 应用一份已确认的结构变更计划
 * GET    /tables/:tableId/views                      — 视图列表
 * POST   /tables/:tableId/views                      — 创建视图
 * PATCH  /views/:viewId                              — 更新视图
 * POST   /tables/:tableId/records/query              — 查询记录
 * POST   /tables/:tableId/records                    — 创建记录
 * GET    /tables/:tableId/records/:recordId          — 读取记录
 * PATCH  /tables/:tableId/records/:recordId          — revision 更新记录
 * POST   /tables/:tableId/records/batch-validate     — 批量预校验
 * POST   /tables/:tableId/records/batch-upsert       — 批量 upsert
 * DELETE /tables/:tableId/records/:recordId          — revision 软删除
 * GET    /tables/:tableId/records/deleted            — 回收站（已软删记录）
 * POST   /tables/:tableId/records/:recordId/restore  — 从回收站恢复记录
 * GET    /bases/:baseId/dashboards                   — Dashboard 列表
 * POST   /bases/:baseId/dashboards                   — 创建 Dashboard
 * GET    /dashboards/:dashboardId                    — Dashboard + widgets
 * PATCH  /dashboards/:dashboardId                    — 更新 Dashboard
 * DELETE /dashboards/:dashboardId                    — 删除 Dashboard（仅 owner，硬删不可恢复）
 * POST   /dashboards/:dashboardId/widgets            — 创建 widget
 * PATCH  /dashboard-widgets/:widgetId                — 更新 widget
 * DELETE /dashboard-widgets/:widgetId                — 删除 widget
 * POST   /dashboard-widgets/:widgetId/query          — 服务端 widget 查询
 */

import { Hono, type Context } from 'hono';
import {
  getDb,
  type TableBaseMemberRow,
  type TableBaseRow,
  type TableDashboardResult,
  type TableDashboardRow,
  type TableDashboardWidgetRow,
  type TableDefinitionRow,
  type TableFieldRow,
  type TableFormRow,
  type TableAutomationRuleRow,
  type TableAutomationRunRow,
  type TableNotificationRow,
  type TableRecordQueryResult,
  type TableRecordRow,
  type TableSchemaResult,
  type TableSchemaVersionRow,
  type TableViewRow,
  type PlatformAuditEventRow,
} from '@greenhouse/db';
import type {
  SchemaPlanApplyResult,
  SchemaPlanOperation,
  TableBaseRole,
  TableBatchValidationResult,
} from '@greenhouse/types/tables';
import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import { humanActor } from '../platform/actor.js';
import { tablesResource, type TablesActionId } from '../platform/tables/application.js';
import { analyzeSchemaPlan, applySchemaPlan, schemaPlanApplySchema } from '../platform/tables/schema-plan.js';
import { getPlatformRuntime } from '../platform/runtime.js';
import { artifactReceiptResult, claimArtifactAction } from '../chat/artifact-actions.js';
import { toErrorMessage } from '@greenhouse/utils/error';

type ActionFailure = {
  ok: false;
  code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'INTERNAL_ERROR';
  message: string;
  details?: Record<string, unknown>;
};

function errorStatus(code: ActionFailure['code']): 400 | 403 | 404 | 409 | 500 {
  if (code === 'FORBIDDEN') return 403;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'CONFLICT') return 409;
  if (code === 'INTERNAL_ERROR') return 500;
  return 400;
}

function actionError(c: Context, result: ActionFailure) {
  return c.json(
    {
      error: result.message,
      ...(result.details ? { details: result.details } : {}),
    },
    errorStatus(result.code),
  );
}

function numberParam(c: Context, key: string): number {
  return Number(c.req.param(key));
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => ({}));
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

async function dispatch(
  c: Context,
  actionId: TablesActionId,
  payload: unknown,
  ids: Parameters<typeof tablesResource>[1] = {},
) {
  return getPlatformRuntime().dispatch({
    actor: humanActor(getAuthUser(c), c),
    appId: 'tables',
    actionId,
    payload,
    resource: tablesResource(actionId, ids),
  });
}

const tablesRoutes = new Hono<AppEnv>()
  .get('/meta/users', async (c) => {
    const result = await dispatch(c, 'listAssignableUsers', {});
    if (!result.ok) return actionError(c, result);
    return c.json(
      result.data as {
        users: Array<{ id: string; nickname: string; email: string; role: 'team' | 'super' }>;
      },
    );
  })
  .get('/bases', async (c) => {
    const result = await dispatch(c, 'listBases', { search: c.req.query('search') || undefined });
    if (!result.ok) return actionError(c, result);
    return c.json(
      result.data as {
        bases: Array<TableBaseRow & { role: TableBaseRole }>;
      },
    );
  })
  .post('/bases', async (c) => {
    const body = await jsonBody(c);
    const result = await dispatch(c, 'createBase', body);
    if (!result.ok) return actionError(c, result);
    return c.json(
      result.data as {
        base: TableBaseRow;
        role: 'owner';
        schema: TableSchemaResult;
      },
      201,
    );
  })
  .get('/bases/:baseId', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'getBase', { baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(
      result.data as {
        base: TableBaseRow;
        role: TableBaseRole;
        tables: TableDefinitionRow[];
        dashboards: TableDashboardRow[];
        members: TableBaseMemberRow[];
      },
    );
  })
  .patch('/bases/:baseId', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'updateBase', { ...(await jsonBody(c)), baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { base: TableBaseRow });
  })
  .post('/bases/:baseId/archive', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'archiveBase', { baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { base: TableBaseRow });
  })
  .get('/bases/:baseId/members', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'listMembers', { baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { members: TableBaseMemberRow[] });
  })
  .get('/bases/:baseId/audit', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const limit = Number(c.req.query('limit')) || undefined;
    const result = await dispatch(c, 'listBaseAudit', { baseId, limit }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { events: PlatformAuditEventRow[] });
  })
  .put('/bases/:baseId/members/:userId', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const userId = c.req.param('userId');
    const result = await dispatch(
      c,
      'manageMembers',
      { ...(await jsonBody(c)), operation: 'upsert', baseId, userId },
      { baseId },
    );
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { member: TableBaseMemberRow });
  })
  .delete('/bases/:baseId/members/:userId', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const userId = c.req.param('userId');
    const result = await dispatch(c, 'manageMembers', { operation: 'remove', baseId, userId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { success: true });
  })
  .get('/bases/:baseId/tables', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'listTables', { baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { tables: TableDefinitionRow[] });
  })
  .post('/bases/:baseId/tables', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'createTable', { ...(await jsonBody(c)), baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as TableSchemaResult, 201);
  })
  .patch('/tables/:tableId', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'updateTable', { ...(await jsonBody(c)), tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { table: TableDefinitionRow });
  })
  .post('/tables/:tableId/archive', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'archiveTable', { tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { table: TableDefinitionRow });
  })
  .get('/tables/:tableId/schema', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'getSchema', { tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as TableSchemaResult);
  })
  .get('/tables/:tableId/schema/versions', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'listSchemaVersions', { tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { versions: TableSchemaVersionRow[] });
  })
  .get('/tables/:tableId/schema/versions/:version', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const version = numberParam(c, 'version');
    const result = await dispatch(c, 'getSchemaVersion', { tableId, version }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { version: TableSchemaVersionRow });
  })
  .post('/tables/:tableId/fields', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'createField', { ...(await jsonBody(c)), tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { field: TableFieldRow }, 201);
  })
  .patch('/fields/:fieldId', async (c) => {
    const fieldId = numberParam(c, 'fieldId');
    const result = await dispatch(c, 'updateField', { ...(await jsonBody(c)), fieldId }, { fieldId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { field: TableFieldRow });
  })
  .post('/fields/:fieldId/archive', async (c) => {
    const fieldId = numberParam(c, 'fieldId');
    const result = await dispatch(c, 'archiveField', { fieldId }, { fieldId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { field: TableFieldRow });
  })
  /**
   * The confirm gate behind `tables_schema_plan`. The tool only drafts; this is
   * where a plan becomes real, and it is reachable only with the user's own
   * bearer token — no model-facing surface can call it. Each operation is
   * re-authorized by its own runtime action, so a tampered plan can never
   * exceed what its sender could already do through the UI.
   */
  .post('/schema-plan/apply', async (c) => {
    const raw = await jsonBody(c);
    const parsed = schemaPlanApplySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid schema plan' }, 400);
    }
    const actionId = typeof raw.action_id === 'string' ? raw.action_id : '';
    const sessionId = typeof raw.session_id === 'string' ? raw.session_id : '';
    if (!actionId || !sessionId) return c.json({ error: 'action_id and session_id are required' }, 400);
    const operations = parsed.data.operations as SchemaPlanOperation[];
    const shape = analyzeSchemaPlan(operations);
    if ('error' in shape) return c.json({ error: shape.error }, 400);
    const claim = await claimArtifactAction({
      actionId,
      sessionId,
      user: getAuthUser(c),
      kind: 'tables_schema_plan',
      payload: operations,
    });
    if (!claim.ok) return c.json({ error: claim.error }, claim.status);
    if (!claim.claimed) {
      const prior = artifactReceiptResult<SchemaPlanApplyResult>(claim.receipt);
      if (prior) return c.json(prior);
      return c.json(
        { error: claim.receipt.error ?? 'This schema plan is already being applied; refresh to check its receipt' },
        409,
      );
    }
    try {
      const applied = await applySchemaPlan(operations, (actionId, payload, ids) =>
        dispatch(c, actionId, payload, ids),
      );
      await getDb().chatArtifactReceipts.succeed(actionId, getAuthUser(c).id, applied);
      return c.json(applied);
    } catch (error) {
      const message = toErrorMessage(error);
      await getDb().chatArtifactReceipts.fail(actionId, getAuthUser(c).id, message);
      return c.json({ error: message }, 500);
    }
  })
  .get('/tables/:tableId/views', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'listViews', { tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { views: TableViewRow[] });
  })
  .post('/tables/:tableId/views', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'createView', { ...(await jsonBody(c)), tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { view: TableViewRow }, 201);
  })
  .patch('/views/:viewId', async (c) => {
    const viewId = numberParam(c, 'viewId');
    const result = await dispatch(c, 'updateView', { ...(await jsonBody(c)), viewId }, { viewId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { view: TableViewRow });
  })
  .get('/tables/:tableId/forms', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'listForms', { tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { forms: TableFormRow[] });
  })
  .post('/tables/:tableId/forms', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'createForm', { ...(await jsonBody(c)), tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { form: TableFormRow }, 201);
  })
  .get('/forms/:formId', async (c) => {
    const formId = numberParam(c, 'formId');
    const result = await dispatch(c, 'getForm', { formId }, { formId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { form: TableFormRow; fields: TableFieldRow[] });
  })
  .patch('/forms/:formId', async (c) => {
    const formId = numberParam(c, 'formId');
    const result = await dispatch(c, 'updateForm', { ...(await jsonBody(c)), formId }, { formId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { form: TableFormRow });
  })
  .post('/forms/:formId/submit', async (c) => {
    const formId = numberParam(c, 'formId');
    const result = await dispatch(c, 'submitForm', { ...(await jsonBody(c)), formId }, { formId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { record: TableRecordRow }, 201);
  })
  .post('/tables/:tableId/records/query', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'queryRecords', { tableId, query: await jsonBody(c) }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as TableRecordQueryResult);
  })
  .post('/tables/:tableId/records', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'createRecord', { ...(await jsonBody(c)), tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { record: TableRecordRow }, 201);
  })
  /**
   * Registered before `/records/:recordId` on purpose — `deleted` would
   * otherwise be read as a record id and answered with a 400.
   */
  .get('/tables/:tableId/records/deleted', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const limit = Number(c.req.query('limit')) || undefined;
    const result = await dispatch(c, 'listDeletedRecords', { tableId, limit }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { records: TableRecordRow[] });
  })
  .post('/tables/:tableId/records/:recordId/restore', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const recordId = numberParam(c, 'recordId');
    const result = await dispatch(c, 'restoreRecord', { tableId, recordId }, { tableId, recordId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { record: TableRecordRow });
  })
  .get('/tables/:tableId/records/:recordId', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const recordId = numberParam(c, 'recordId');
    const result = await dispatch(c, 'getRecord', { tableId, recordId }, { tableId, recordId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { record: TableRecordRow });
  })
  .patch('/tables/:tableId/records/:recordId', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const recordId = numberParam(c, 'recordId');
    const result = await dispatch(
      c,
      'updateRecord',
      { ...(await jsonBody(c)), tableId, recordId },
      { tableId, recordId },
    );
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { record: TableRecordRow });
  })
  .post('/tables/:tableId/records/batch-upsert', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'batchUpsertRecords', { ...(await jsonBody(c)), tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(
      result.data as {
        results: Array<
          | { index: number; ok: true; record: TableRecordRow }
          | {
              index: number;
              ok: false;
              reason: 'not_found' | 'conflict' | 'invalid';
              message?: string;
              current?: number;
            }
        >;
      },
    );
  })
  .post('/tables/:tableId/records/batch-validate', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'validateBatchRecords', { ...(await jsonBody(c)), tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { results: TableBatchValidationResult[] });
  })
  .delete('/tables/:tableId/records/:recordId', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const recordId = numberParam(c, 'recordId');
    const revision = Number(c.req.query('revision'));
    const result = await dispatch(c, 'deleteRecord', { tableId, recordId, revision }, { tableId, recordId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { record: TableRecordRow });
  })
  .get('/bases/:baseId/automations', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'listAutomations', { baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { automations: TableAutomationRuleRow[] });
  })
  .post('/bases/:baseId/automations', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'createAutomation', { ...(await jsonBody(c)), baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { automation: TableAutomationRuleRow }, 201);
  })
  .patch('/automations/:automationId', async (c) => {
    const automationId = numberParam(c, 'automationId');
    const result = await dispatch(c, 'updateAutomation', { ...(await jsonBody(c)), automationId }, { automationId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { automation: TableAutomationRuleRow });
  })
  .get('/automations/:automationId/runs', async (c) => {
    const automationId = numberParam(c, 'automationId');
    const limit = Number(c.req.query('limit')) || undefined;
    const result = await dispatch(c, 'listAutomationRuns', { automationId, limit }, { automationId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { runs: TableAutomationRunRow[] });
  })
  .get('/notifications', async (c) => {
    const limit = Number(c.req.query('limit')) || undefined;
    const result = await dispatch(c, 'listNotifications', { limit });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { notifications: TableNotificationRow[] });
  })
  .post('/notifications/:notificationId/read', async (c) => {
    const notificationId = numberParam(c, 'notificationId');
    const result = await dispatch(c, 'markNotificationRead', { notificationId }, { notificationId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { notification: TableNotificationRow });
  })
  .get('/bases/:baseId/dashboards', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'listDashboards', { baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { dashboards: TableDashboardRow[] });
  })
  .post('/bases/:baseId/dashboards', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'createDashboard', { ...(await jsonBody(c)), baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { dashboard: TableDashboardRow }, 201);
  })
  .get('/dashboards/:dashboardId', async (c) => {
    const dashboardId = numberParam(c, 'dashboardId');
    const result = await dispatch(c, 'getDashboard', { dashboardId }, { dashboardId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as TableDashboardResult);
  })
  .patch('/dashboards/:dashboardId', async (c) => {
    const dashboardId = numberParam(c, 'dashboardId');
    const result = await dispatch(c, 'updateDashboard', { ...(await jsonBody(c)), dashboardId }, { dashboardId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { dashboard: TableDashboardRow });
  })
  .delete('/dashboards/:dashboardId', async (c) => {
    const dashboardId = numberParam(c, 'dashboardId');
    const result = await dispatch(c, 'deleteDashboard', { dashboardId }, { dashboardId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { success: true });
  })
  .post('/dashboards/:dashboardId/widgets', async (c) => {
    const dashboardId = numberParam(c, 'dashboardId');
    const result = await dispatch(c, 'createDashboardWidget', { ...(await jsonBody(c)), dashboardId }, { dashboardId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { widget: TableDashboardWidgetRow }, 201);
  })
  .patch('/dashboard-widgets/:widgetId', async (c) => {
    const widgetId = numberParam(c, 'widgetId');
    const result = await dispatch(c, 'updateDashboardWidget', { ...(await jsonBody(c)), widgetId }, { widgetId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { widget: TableDashboardWidgetRow });
  })
  .delete('/dashboard-widgets/:widgetId', async (c) => {
    const widgetId = numberParam(c, 'widgetId');
    const result = await dispatch(c, 'deleteDashboardWidget', { widgetId }, { widgetId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { success: true });
  })
  .post('/dashboard-widgets/:widgetId/query', async (c) => {
    const widgetId = numberParam(c, 'widgetId');
    const result = await dispatch(c, 'queryDashboardWidget', { widgetId }, { widgetId });
    if (!result.ok) return actionError(c, result);
    return c.json(
      result.data as {
        widget: TableDashboardWidgetRow;
        text?: string;
        rows?: Array<{ group: string | number | boolean | null; value: number }>;
        records?: TableRecordQueryResult;
      },
    );
  });

export default tablesRoutes;
