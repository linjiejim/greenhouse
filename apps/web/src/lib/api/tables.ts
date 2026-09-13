/**
 * Typed Tables API client.
 */

import type {
  SchemaPlanApplyResult,
  SchemaPlanOperation,
  TableBaseRole,
  TableBaseVisibility,
  TableDashboardWidgetConfig,
  TableDashboardWidgetLayout,
  TableDashboardWidgetType,
  TableAutomationConfig,
  TableAutomationTrigger,
  TableFieldConfig,
  TableFieldType,
  TableFormConfig,
  TableQuery,
  TableRecordValues,
  TableSchemaSnapshot,
} from '@greenhouse/types/tables';
import { authFetch } from '../auth';
import { rpc } from './client';

export interface TableBase {
  id: number;
  name: string;
  description: string | null;
  visibility: TableBaseVisibility;
  owner_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface TableBaseWithRole extends TableBase {
  role: TableBaseRole;
}

export interface TableDefinition {
  id: number;
  base_id: number;
  name: string;
  description: string | null;
  position: number;
  schema_revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface TableField {
  id: number;
  table_id: number;
  name: string;
  type: TableFieldType;
  required: boolean;
  is_primary: boolean;
  config: string;
  position: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface TableView {
  id: number;
  table_id: number;
  name: string;
  type: 'grid';
  scope: 'shared' | 'personal';
  owner_id: string | null;
  config: string;
  position: number;
  revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface TableRecord {
  id: number;
  table_id: number;
  values: TableRecordValues;
  computed_values: TableRecordValues;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface TableForm {
  id: number;
  table_id: number;
  name: string;
  status: 'draft' | 'published';
  config: TableFormConfig;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface TableAutomation {
  id: number;
  base_id: number;
  table_id: number;
  name: string;
  status: 'disabled' | 'enabled';
  trigger: TableAutomationTrigger;
  config: TableAutomationConfig;
  execution_user_id: string;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface TableAutomationRun {
  id: number;
  rule_id: number;
  outbox_id: number | null;
  status: 'running' | 'succeeded' | 'failed';
  actions_completed: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface TableNotification {
  id: number;
  user_id: string;
  base_id: number;
  rule_id: number | null;
  record_id: number | null;
  title: string;
  message: string;
  read_at: string | null;
  created_at: string;
}

export interface TableDashboard {
  id: number;
  base_id: number;
  name: string;
  description: string | null;
  revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface TableDashboardWidget {
  id: number;
  dashboard_id: number;
  table_id: number | null;
  type: TableDashboardWidgetType;
  title: string;
  config: string;
  layout: string;
  position: number;
  revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface TableSchema {
  table: TableDefinition;
  fields: TableField[];
  views: TableView[];
}

export interface TableRecordPage {
  records: TableRecord[];
  total: number;
  nextCursor: string | null;
}

export interface TableSchemaVersion {
  id: number;
  table_id: number;
  version: number;
  schema_snapshot: TableSchemaSnapshot;
  change_type: 'created' | 'field_created' | 'field_updated' | 'field_archived';
  changed_by: string;
  request_id: string | null;
  created_at: string;
}

export interface TableBatchRecordItem {
  record_id?: number;
  revision?: number;
  values: TableRecordValues;
}

export type TableBatchValidation = {
  index: number;
  ok: boolean;
  reason?: 'not_found' | 'conflict' | 'invalid';
  message?: string;
  current?: number;
};

export interface TableAuditEvent {
  id: string;
  org_id: string;
  actor_id: string;
  actor_type: 'human' | 'agent' | 'service' | 'system' | 'migration';
  on_behalf_of_user_id: string | null;
  client_id: string | null;
  request_id: string;
  app_id: string;
  module_id: string | null;
  entity_id: string | null;
  record_id: string | null;
  action_id: string;
  capability: string;
  result: 'success' | 'denied' | 'error';
  summary: string;
  created_at: string;
}

export interface TableBaseWorkspace {
  base: TableBase;
  role: TableBaseRole;
  tables: TableDefinition[];
  dashboards: TableDashboard[];
  members: Array<{
    id: number;
    base_id: number;
    user_id: string;
    role: TableBaseRole;
    added_by: string;
    created_at: string;
    updated_at: string;
  }>;
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error || fallback);
}

export async function listTableBases(search?: string): Promise<TableBaseWithRole[]> {
  const response = await rpc.api.tables.bases.$get({ query: search ? { search } : {} });
  if (!response.ok) throw await responseError(response, 'Unable to load Tables');
  return (await response.json()).bases;
}

export async function createTableBase(input: {
  name: string;
  description?: string;
  visibility: TableBaseVisibility;
  defaultTableName?: string;
}): Promise<{ base: TableBase; role: 'owner'; schema: TableSchema }> {
  const response = await rpc.api.tables.bases.$post({ json: input });
  if (!response.ok) throw await responseError(response, 'Unable to create Base');
  return response.json();
}

export async function getTableBase(baseId: number): Promise<TableBaseWorkspace> {
  const response = await rpc.api.tables.bases[':baseId'].$get({ param: { baseId: String(baseId) } });
  if (!response.ok) throw await responseError(response, 'Unable to load Base');
  return response.json();
}

export async function listTableUsers(): Promise<
  Array<{ id: string; nickname: string; email: string; role: 'team' | 'super' }>
> {
  const response = await rpc.api.tables.meta.users.$get();
  if (!response.ok) throw await responseError(response, 'Unable to load users');
  return (await response.json()).users;
}

export async function updateTableBase(
  baseId: number,
  input: { name?: string; description?: string | null; visibility?: TableBaseVisibility },
): Promise<TableBase> {
  const args = { param: { baseId: String(baseId) }, json: input };
  const response = await rpc.api.tables.bases[':baseId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update Base');
  return (await response.json()).base;
}

export async function upsertTableBaseMember(
  baseId: number,
  userId: string,
  role: Exclude<TableBaseRole, 'owner'>,
): Promise<TableBaseWorkspace['members'][number]> {
  const args = { param: { baseId: String(baseId), userId }, json: { role } };
  const response = await rpc.api.tables.bases[':baseId'].members[':userId'].$put(args);
  if (!response.ok) throw await responseError(response, 'Unable to update member');
  return (await response.json()).member;
}

export async function removeTableBaseMember(baseId: number, userId: string): Promise<void> {
  const response = await rpc.api.tables.bases[':baseId'].members[':userId'].$delete({
    param: { baseId: String(baseId), userId },
  });
  if (!response.ok) throw await responseError(response, 'Unable to remove member');
}

export async function listTableBaseAudit(baseId: number, limit = 100): Promise<TableAuditEvent[]> {
  const response = await authFetch(`/api/tables/bases/${baseId}/audit?limit=${limit}`);
  if (!response.ok) throw await responseError(response, 'Unable to load Base audit');
  return ((await response.json()) as { events: TableAuditEvent[] }).events;
}

export async function createTableDefinition(
  baseId: number,
  input: { name: string; description?: string },
): Promise<TableSchema> {
  const args = { param: { baseId: String(baseId) }, json: input };
  const response = await rpc.api.tables.bases[':baseId'].tables.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to create Table');
  return response.json();
}

export async function updateTableDefinition(
  tableId: number,
  input: { name?: string; description?: string | null },
): Promise<TableDefinition> {
  const args = { param: { tableId: String(tableId) }, json: input };
  const response = await rpc.api.tables.tables[':tableId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update Table');
  return (await response.json()).table;
}

/**
 * Deleting a table archives it: records, links and fields stay untouched and an
 * administrator can bring it back with `pnpm cli tables restore-table <id>`.
 * Only the Base creator may do this (spec D3).
 */
export async function archiveTableDefinition(tableId: number): Promise<TableDefinition> {
  const response = await rpc.api.tables.tables[':tableId'].archive.$post({ param: { tableId: String(tableId) } });
  if (!response.ok) throw await responseError(response, 'Unable to delete Table');
  return (await response.json()).table;
}

export async function archiveTableBase(baseId: number): Promise<TableBase> {
  const response = await rpc.api.tables.bases[':baseId'].archive.$post({ param: { baseId: String(baseId) } });
  if (!response.ok) throw await responseError(response, 'Unable to delete Base');
  return (await response.json()).base;
}

export async function getTableSchema(tableId: number): Promise<TableSchema> {
  const response = await rpc.api.tables.tables[':tableId'].schema.$get({ param: { tableId: String(tableId) } });
  if (!response.ok) throw await responseError(response, 'Unable to load schema');
  return response.json();
}

export async function listTableSchemaVersions(tableId: number): Promise<TableSchemaVersion[]> {
  const response = await rpc.api.tables.tables[':tableId'].schema.versions.$get({
    param: { tableId: String(tableId) },
  });
  if (!response.ok) throw await responseError(response, 'Unable to load schema versions');
  return (await response.json()).versions;
}

export async function createTableField(
  tableId: number,
  input: {
    name: string;
    type: TableFieldType;
    required?: boolean;
    config?: TableFieldConfig;
  },
): Promise<TableField> {
  const args = { param: { tableId: String(tableId) }, json: input };
  const response = await rpc.api.tables.tables[':tableId'].fields.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to create field');
  return (await response.json()).field;
}

export async function updateTableField(
  fieldId: number,
  input: { name?: string; required?: boolean; config?: TableFieldConfig; position?: number },
): Promise<TableField> {
  const args = { param: { fieldId: String(fieldId) }, json: input };
  const response = await rpc.api.tables.fields[':fieldId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update field');
  return (await response.json()).field;
}

export async function archiveTableField(fieldId: number): Promise<TableField> {
  const response = await rpc.api.tables.fields[':fieldId'].archive.$post({ param: { fieldId: String(fieldId) } });
  if (!response.ok) throw await responseError(response, 'Unable to archive field');
  return (await response.json()).field;
}

/**
 * Applies a schema plan the model drafted and the user confirmed. This is the
 * only way a `tables_schema_plan` card becomes real — the tool itself writes
 * nothing, and the server re-authorizes every operation on its own.
 */
export async function applyTableSchemaPlan(
  operations: SchemaPlanOperation[],
  receipt: { actionId: string; sessionId: string },
): Promise<SchemaPlanApplyResult> {
  const response = await rpc.api.tables['schema-plan'].apply.$post({
    json: { operations, action_id: receipt.actionId, session_id: receipt.sessionId },
  });
  if (!response.ok) throw await responseError(response, 'Unable to apply the schema plan');
  return await response.json();
}

export async function createTableView(
  tableId: number,
  input: { name: string; scope: 'shared' | 'personal'; config?: Record<string, unknown> },
): Promise<TableView> {
  const args = { param: { tableId: String(tableId) }, json: input };
  const response = await rpc.api.tables.tables[':tableId'].views.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to create view');
  return (await response.json()).view;
}

export async function updateTableView(
  viewId: number,
  input: { revision: number; name?: string; config?: Record<string, unknown>; position?: number },
): Promise<TableView> {
  const args = { param: { viewId: String(viewId) }, json: input };
  const response = await rpc.api.tables.views[':viewId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update view');
  return (await response.json()).view;
}

export async function listTableForms(tableId: number): Promise<TableForm[]> {
  const response = await authFetch(`/api/tables/tables/${tableId}/forms`);
  if (!response.ok) throw await responseError(response, 'Unable to load forms');
  return ((await response.json()) as { forms: TableForm[] }).forms;
}

export async function getTableForm(formId: number): Promise<{ form: TableForm; fields: TableField[] }> {
  const response = await authFetch(`/api/tables/forms/${formId}`);
  if (!response.ok) throw await responseError(response, 'Unable to load form');
  return response.json() as Promise<{ form: TableForm; fields: TableField[] }>;
}

export async function createTableForm(
  tableId: number,
  input: { name: string; status?: 'draft' | 'published'; config: TableFormConfig },
): Promise<TableForm> {
  const response = await authFetch(`/api/tables/tables/${tableId}/forms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await responseError(response, 'Unable to create form');
  return ((await response.json()) as { form: TableForm }).form;
}

export async function updateTableForm(
  formId: number,
  input: { revision: number; name?: string; status?: 'draft' | 'published'; config?: TableFormConfig },
): Promise<TableForm> {
  const response = await authFetch(`/api/tables/forms/${formId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await responseError(response, 'Unable to update form');
  return ((await response.json()) as { form: TableForm }).form;
}

export async function submitTableForm(formId: number, values: TableRecordValues): Promise<TableRecord> {
  const response = await authFetch(`/api/tables/forms/${formId}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  if (!response.ok) throw await responseError(response, 'Unable to submit form');
  return ((await response.json()) as { record: TableRecord }).record;
}

export async function queryTableRecords(tableId: number, query: TableQuery): Promise<TableRecordPage> {
  const args = { param: { tableId: String(tableId) }, json: query };
  const response = await rpc.api.tables.tables[':tableId'].records.query.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to query records');
  return response.json();
}

export async function createTableRecord(tableId: number, values: TableRecordValues): Promise<TableRecord> {
  const args = { param: { tableId: String(tableId) }, json: { values } };
  const response = await rpc.api.tables.tables[':tableId'].records.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to create record');
  return (await response.json()).record;
}

export async function updateTableRecord(
  tableId: number,
  recordId: number,
  revision: number,
  values: TableRecordValues,
): Promise<TableRecord> {
  const args = {
    param: { tableId: String(tableId), recordId: String(recordId) },
    json: { revision, values },
  };
  const response = await rpc.api.tables.tables[':tableId'].records[':recordId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update record');
  return (await response.json()).record;
}

export async function validateTableRecordBatch(
  tableId: number,
  items: TableBatchRecordItem[],
): Promise<TableBatchValidation[]> {
  const args = { param: { tableId: String(tableId) }, json: { items } };
  const response = await rpc.api.tables.tables[':tableId'].records['batch-validate'].$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to validate pasted records');
  return (await response.json()).results;
}

export async function upsertTableRecordBatch(
  tableId: number,
  items: TableBatchRecordItem[],
): Promise<
  Array<
    | { index: number; ok: true; record: TableRecord }
    | {
        index: number;
        ok: false;
        reason: 'not_found' | 'conflict' | 'invalid';
        message?: string;
        current?: number;
      }
  >
> {
  const args = { param: { tableId: String(tableId) }, json: { items } };
  const response = await rpc.api.tables.tables[':tableId'].records['batch-upsert'].$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to paste records');
  return (await response.json()).results;
}

export async function deleteTableRecord(tableId: number, recordId: number, revision: number): Promise<void> {
  const response = await authFetch(`/api/tables/tables/${tableId}/records/${recordId}?revision=${revision}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw await responseError(response, 'Unable to delete record');
}

/** The recycle bin feed — soft-deleted rows, newest first. */
export async function listDeletedTableRecords(tableId: number, limit = 100): Promise<TableRecord[]> {
  const response = await authFetch(`/api/tables/tables/${tableId}/records/deleted?limit=${limit}`);
  if (!response.ok) throw await responseError(response, 'Unable to load deleted records');
  return ((await response.json()) as { records: TableRecord[] }).records;
}

export async function restoreTableRecord(tableId: number, recordId: number): Promise<TableRecord> {
  const args = { param: { tableId: String(tableId), recordId: String(recordId) } };
  const response = await rpc.api.tables.tables[':tableId'].records[':recordId'].restore.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to restore record');
  return (await response.json()).record;
}

export async function listTableAutomations(baseId: number): Promise<TableAutomation[]> {
  const response = await authFetch(`/api/tables/bases/${baseId}/automations`);
  if (!response.ok) throw await responseError(response, 'Unable to load automations');
  return ((await response.json()) as { automations: TableAutomation[] }).automations;
}

export async function createTableAutomation(
  baseId: number,
  input: {
    tableId: number;
    name: string;
    status?: 'disabled' | 'enabled';
    trigger: TableAutomationTrigger;
    config: TableAutomationConfig;
  },
): Promise<TableAutomation> {
  const response = await authFetch(`/api/tables/bases/${baseId}/automations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await responseError(response, 'Unable to create automation');
  return ((await response.json()) as { automation: TableAutomation }).automation;
}

export async function updateTableAutomation(
  automationId: number,
  input: {
    revision: number;
    name?: string;
    status?: 'disabled' | 'enabled';
    trigger?: TableAutomationTrigger;
    config?: TableAutomationConfig;
  },
): Promise<TableAutomation> {
  const response = await authFetch(`/api/tables/automations/${automationId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await responseError(response, 'Unable to update automation');
  return ((await response.json()) as { automation: TableAutomation }).automation;
}

export async function listTableAutomationRuns(automationId: number, limit = 20): Promise<TableAutomationRun[]> {
  const response = await authFetch(`/api/tables/automations/${automationId}/runs?limit=${limit}`);
  if (!response.ok) throw await responseError(response, 'Unable to load automation runs');
  return ((await response.json()) as { runs: TableAutomationRun[] }).runs;
}

export async function listTableNotifications(limit = 100): Promise<TableNotification[]> {
  const response = await authFetch(`/api/tables/notifications?limit=${limit}`);
  if (!response.ok) throw await responseError(response, 'Unable to load notifications');
  return ((await response.json()) as { notifications: TableNotification[] }).notifications;
}

export async function markTableNotificationRead(notificationId: number): Promise<TableNotification> {
  const response = await authFetch(`/api/tables/notifications/${notificationId}/read`, { method: 'POST' });
  if (!response.ok) throw await responseError(response, 'Unable to update notification');
  return ((await response.json()) as { notification: TableNotification }).notification;
}

export async function createTableDashboard(baseId: number, name: string): Promise<TableDashboard> {
  const args = { param: { baseId: String(baseId) }, json: { name } };
  const response = await rpc.api.tables.bases[':baseId'].dashboards.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to create dashboard');
  return (await response.json()).dashboard;
}

export async function updateTableDashboard(
  dashboardId: number,
  input: { revision: number; name?: string; description?: string | null },
): Promise<TableDashboard> {
  const args = { param: { dashboardId: String(dashboardId) }, json: input };
  const response = await rpc.api.tables.dashboards[':dashboardId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update dashboard');
  return (await response.json()).dashboard;
}

/** Unlike Bases and tables, a dashboard is pure configuration and really goes (spec D4). */
export async function deleteTableDashboard(dashboardId: number): Promise<void> {
  const response = await rpc.api.tables.dashboards[':dashboardId'].$delete({
    param: { dashboardId: String(dashboardId) },
  });
  if (!response.ok) throw await responseError(response, 'Unable to delete dashboard');
}

export async function getTableDashboard(
  dashboardId: number,
): Promise<{ dashboard: TableDashboard; widgets: TableDashboardWidget[] }> {
  const response = await rpc.api.tables.dashboards[':dashboardId'].$get({
    param: { dashboardId: String(dashboardId) },
  });
  if (!response.ok) throw await responseError(response, 'Unable to load dashboard');
  return response.json();
}

export async function createTableDashboardWidget(
  dashboardId: number,
  input: {
    tableId?: number;
    type: TableDashboardWidgetType;
    title: string;
    config?: TableDashboardWidgetConfig;
    layout?: TableDashboardWidgetLayout;
  },
): Promise<TableDashboardWidget> {
  const args = { param: { dashboardId: String(dashboardId) }, json: input };
  const response = await rpc.api.tables.dashboards[':dashboardId'].widgets.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to create widget');
  return (await response.json()).widget;
}

export async function updateTableDashboardWidget(
  widgetId: number,
  input: {
    revision: number;
    tableId?: number | null;
    title?: string;
    config?: TableDashboardWidgetConfig;
    layout?: TableDashboardWidgetLayout;
    position?: number;
  },
): Promise<TableDashboardWidget> {
  const args = { param: { widgetId: String(widgetId) }, json: input };
  const response = await rpc.api.tables['dashboard-widgets'][':widgetId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update widget');
  return (await response.json()).widget;
}

export async function deleteTableDashboardWidget(widgetId: number): Promise<void> {
  const response = await rpc.api.tables['dashboard-widgets'][':widgetId'].$delete({
    param: { widgetId: String(widgetId) },
  });
  if (!response.ok) throw await responseError(response, 'Unable to delete widget');
}

export async function queryTableDashboardWidget(widgetId: number): Promise<{
  widget: TableDashboardWidget;
  text?: string;
  rows?: Array<{ group: string | number | boolean | null; value: number }>;
  records?: TableRecordPage;
}> {
  const response = await rpc.api.tables['dashboard-widgets'][':widgetId'].query.$post({
    param: { widgetId: String(widgetId) },
  });
  if (!response.ok) throw await responseError(response, 'Unable to query widget');
  return response.json();
}
