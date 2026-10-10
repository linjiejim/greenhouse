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
 *   compute.ts      formula / rollup computation and recompute
 *   schema.ts       Bases, tables, fields, schema versions
 *   members.ts      Base membership rows
 *   views.ts        saved views
 *   records.ts      record reads / writes (scope + write meta required)
 *   aggregate.ts    aggregates (date buckets, series)
 *   activity.ts     record history + `onRecordWritten`
 *   forms.ts        forms and submissions
 *   automations.ts  rules, runs, enqueue entry point, legacy executor
 *   dashboards.ts   dashboards and widgets
 *   resources.ts    resource → owning Base (the Base audit feed's reverse lookup)
 */

import type { Db } from '../../client.js';
import { createTablesActivity } from './activity.js';
import { createTablesAggregates } from './aggregate.js';
import { createTablesAutomations } from './automations.js';
import { createTablesCompute } from './compute.js';
import { createTablesDashboards } from './dashboards.js';
import { createTablesForms } from './forms.js';
import { createTablesMembers } from './members.js';
import { createTablesRecords } from './records.js';
import { createTablesResources } from './resources.js';
import { createTablesSchema } from './schema.js';
import { createTablesViews } from './views.js';

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
  type CreateTableAutomationInput,
  type TableAutomationConfigInput,
  type UpdateTableAutomationInput,
} from './automations.js';
export type {
  CreateTableBaseInput,
  CreateTableDefinitionInput,
  CreateTableFieldInput,
  TableSchemaResult,
  UpdateTableBaseInput,
  UpdateTableFieldInput,
} from './schema.js';
export type { CreateTableViewInput, UpdateTableViewInput } from './views.js';
export { TABLES_RESOURCE_KINDS, type TablesResourceKind } from './resources.js';
export type { CreateTableFormInput, UpdateTableFormInput } from './forms.js';
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
export type {
  CreateTableDashboardInput,
  CreateTableDashboardWidgetInput,
  TableDashboardResult,
  UpdateTableDashboardInput,
  UpdateTableDashboardWidgetInput,
} from './dashboards.js';

export function createTablesService(db: Db) {
  const compute = createTablesCompute(db);
  const { canUserEditBase, ...members } = createTablesMembers(db);
  const views = createTablesViews(db);
  // The legacy executor and the record writes reference each other; the
  // executor is bound after both exist (it only runs after a write commits).
  const legacy: { run?: ReturnType<typeof createTablesAutomations>['runLegacyAutomations'] } = {};
  const records = createTablesRecords(db, {
    compute,
    afterCommit: async (trigger, record, meta) => {
      await legacy.run?.(trigger, record, meta);
    },
  });
  const automations = createTablesAutomations(db, {
    records: records.internal,
    canUserEditBase,
  });
  legacy.run = automations.runLegacyAutomations;

  return {
    ...createTablesSchema(db, { compute, listViews: views.listViews }),
    ...members,
    ...views,
    ...records.service,
    ...createTablesAggregates(db),
    ...createTablesActivity(db),
    ...createTablesForms(db, { records: records.internal }),
    ...automations.service,
    ...createTablesDashboards(db),
    ...createTablesResources(db),
  };
}

export type TablesService = ReturnType<typeof createTablesService>;
