/**
 * Tables domain service — fixed-schema metadata, validated dynamic records,
 * one SQL compiler for every predicate, optimistic concurrency, history, and
 * dashboard aggregation.
 *
 * Composed from one module per domain (file ownership in
 * docs/specs/20261011-tables-foundation.md §实施切片):
 *
 *   shared.ts       errors, limits, field / value validation, pure helpers
 *   query.ts        THE SQL compiler (clauses, tokens, row scopes, queries)
 *   compute.ts      formula / rollup / lookup computation, recompute, dependent refresh
 *   formula-eval.ts the formula evaluator (pure; the text syntax is @greenhouse/types/table-formula)
 *   schema.ts       Bases, tables, fields, schema versions
 *   members.ts      Base membership rows (people)
 *   roles.ts        custom roles, group grants, team default, owner transfer, access facts
 *   views.ts        saved views
 *   records.ts      record reads / writes (scope + write meta required)
 *   aggregate.ts    aggregates (date buckets, series)
 *   activity.ts     record history + `onRecordWritten`
 *   comments.ts     record comments + the merged activity feed (comments + history)
 *   forms.ts        forms and submissions
 *   automations.ts  rules (validation, executor, secrets), buttons, the in-transaction enqueue
 *   automation-queue.ts  outbox leases / checkpoints, run rows, sweep queries (the API runs rules)
 *   dashboards.ts   dashboards and widgets
 *   imports.ts      CSV / Excel import lifecycle (stage, claim, chunked commit, sweep)
 *   import-values.ts  import cells → values (links by primary text; the rest is @greenhouse/types/table-cell-text), column inference (pure)
 *   resources.ts    resource → owning Base (stamped on each audited action as its scope)
 *   apps.ts         apps on a Base: drafts (CAS), hashed immutable versions, audiences, pins, "my / shared / featured"
 *   app-gateway.ts  what the app gateway reads / writes beyond records: row matching for preconditions,
 *                   records and files by id, staged app uploads, the action ledger, usage counts
 *   schema-source.ts  what config validators read about the schema (live, or a plan's virtual draft)
 */

import type { Db } from '../../client.js';
import { createTablesActivity } from './activity.js';
import { createTablesApps } from './apps.js';
import { createTablesAppGateway } from './app-gateway.js';
import { createTablesAggregates } from './aggregate.js';
import { createTablesAutomationQueue } from './automation-queue.js';
import { createTablesAutomations } from './automations.js';
import { createTablesComments } from './comments.js';
import { createTablesCompute } from './compute.js';
import { createTablesDashboards } from './dashboards.js';
import { createTablesForms } from './forms.js';
import { createTablesImports } from './imports.js';
import { createTablesMembers } from './members.js';
import { createTablesRecords } from './records.js';
import { createTablesResources } from './resources.js';
import { createTablesRoles } from './roles.js';
import { createTablesSchema } from './schema.js';
import { createTablesViews } from './views.js';
import { dbSchemaSource, type TablesSchemaSource } from './schema-source.js';

export {
  isTablesForbiddenError,
  parseTableFieldConfig,
  projectTableRecord,
  TABLES_FORBIDDEN_CODES,
  TablesValidationError,
  validateTableFieldConfig,
  validateTableFieldValue,
  type TableRecordWrittenEvent,
  type TableRevisionResult,
  type TablesErrorCode,
} from './shared.js';
// The compiler and the write hook stay inside the package: callers outside
// packages/db never build SQL. Only pure validation and the evaluation types
// are public.
export {
  resolveTableEvaluation,
  validateFilterGroupShape,
  validateQueryShape,
  type TableQueryEvaluation,
  type TableRecordQueryParts,
} from './query.js';
export {
  assignAutomationActionIds,
  automationSecretAad,
  checkAutomationConfig,
  normalizeStoredAutomationConfig,
  ruleTimeZone,
  type AutomationScheduling,
  type AutomationSecretSealer,
  type CreateTableAutomationInput,
  type TableAutomationConfigInput,
  type TableAutomationRuleView,
  type UpdateTableAutomationInput,
} from './automations.js';
export { TablesAutomationLeaseLostError, type TablesAutomationQueue } from './automation-queue.js';
export type {
  CreateTableBaseInput,
  CreateTableDefinitionInput,
  CreateTableFieldInput,
  TableSchemaResult,
  UpdateTableBaseInput,
  UpdateTableFieldInput,
} from './schema.js';
export { checkViewConfig, type CreateTableViewInput, type UpdateTableViewInput } from './views.js';
// Config validators that read the schema through a source: write paths pass the
// live schema, the plan tool's draft check a virtual one (spec §9).
export { dbSchemaSource, type TablesSchemaSource, type TablesSourceTable } from './schema-source.js';
export { checkFieldConfig } from './schema.js';
export { TABLES_RESOURCE_KINDS, type TablesResourceKind } from './resources.js';
export type {
  CreateTableBaseRoleInput,
  DeleteTableBaseRoleResult,
  TableBaseGroupGrantRow,
  TablePreviousOwnerRole,
  TableUserGroupGrantRow,
  UpdateTableBaseRoleInput,
} from './roles.js';
export {
  checkFormAudience,
  checkFormConfig,
  formDefaultEntries,
  formUploadKeySegment,
  formWritableFieldIds,
  normalizeFormAudience,
  type CreateTableFormInput,
  type ExpiredFormUpload,
  type SubmitTableFormOptions,
  type UpdateTableFormInput,
} from './forms.js';
export {
  normalizeCommentBody,
  tableCommentView,
  type CreateTableCommentInput,
  type ListTableActivityOptions,
  type UpdateTableCommentInput,
} from './comments.js';
export type {
  BatchUpsertTableRecordItem,
  CreateTableRecordInput,
  DeleteTableRecordInput,
  RecordWriteHooks,
  RestoreTableRecordInput,
  TableBatchUpsertResult,
  TableRecordQueryResult,
  TableRecordWriteResult,
} from './records.js';
export {
  TABLE_IMPORT_CHUNK_ROWS,
  TABLE_IMPORT_MAX_COLUMNS,
  TABLE_IMPORT_MAX_FAILURES,
  TABLE_IMPORT_MAX_LIVE_PER_USER,
  TABLE_IMPORT_MAX_ROWS,
  tableImportDataRows,
  tableImportError,
  tableImportPlan,
  tableImportResult,
  tableImportRowNumber,
  type CreateTableImportInput,
  type TableImportChunkItem,
  type TableImportChunkResult,
  type TableImportClaim,
  type TableImportPlan,
  type TableImportPlanColumn,
} from './imports.js';
export {
  coerceImportValue,
  inferImportColumnType,
  matchImportHeader,
  missingSelectLabels,
  withImportedOptions,
  type ImportField,
  type ImportValueContext,
} from './import-values.js';
export {
  checkDashboardConfig,
  checkWidgetCard,
  type CreateTableDashboardInput,
  type CreateTableDashboardWidgetInput,
  type TableDashboardResult,
  type UpdateTableDashboardInput,
  type UpdateTableDashboardWidgetInput,
} from './dashboards.js';

export {
  appSpecHash,
  verifiedAppVersionSpec,
  type CreateTableAppInput,
  type PublishTableAppResult,
  type ReplaceTableAppAudiencesResult,
  type RestoreTableAppVersionResult,
  type TableAppAudienceInput,
  type TableAppSummaryRow,
  type TableAppVersionSummaryRow,
  type UpdateTableAppInput,
} from './apps.js';
export {
  APP_USAGE_WINDOW_DAYS,
  appUploadKeySegment,
  type AppDriveFileMeta,
  type AppUsageCounts,
  type ClaimAppActionRequestResult,
} from './app-gateway.js';

export function createTablesService(db: Db) {
  const compute = createTablesCompute(db);
  const members = createTablesMembers(db);
  const views = createTablesViews(db);
  const records = createTablesRecords(db, { compute });
  const automations = createTablesAutomations(db);

  return {
    ...createTablesSchema(db, { compute, listViews: views.listViews }),
    ...members,
    ...createTablesRoles(db),
    ...views,
    ...records.service,
    ...createTablesAggregates(db),
    ...createTablesActivity(db),
    ...createTablesComments(db, { getRecord: records.service.getRecord }),
    ...createTablesForms(db, { records: records.internal }),
    ...automations.service,
    ...createTablesAutomationQueue(db),
    ...createTablesDashboards(db),
    ...createTablesImports(db, { records: records.internal }),
    ...createTablesResources(db),
    ...createTablesApps(db),
    ...createTablesAppGateway(db),
    /** The live schema as the config validators read it (the API's app spec validator passes it on). */
    liveSchemaSource: (): TablesSchemaSource => dbSchemaSource(db),
  };
}

export type TablesService = ReturnType<typeof createTablesService>;
