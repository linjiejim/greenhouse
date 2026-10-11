/**
 * Tables wire shapes — what the `/api/tables` (and `/api/forms`) endpoints
 * answer, as clients see them after JSON (timestamps are ISO strings, some
 * configs arrive JSON-encoded exactly as stored).
 *
 * Moved out of `apps/web/src/lib/api/tables/*` (Tables → Apps Phase 1 F1) so
 * every client reads one copy: the web client re-exports these, and the mobile
 * app vendors this file verbatim next to `./tables`, `./table-access` and
 * `./table-cards` (type-only imports, no runtime dependencies). Request bodies
 * stay with each client.
 */

import type {
  TableAutomationConfig,
  TableAutomationRunStatus,
  TableAutomationRunStep,
  TableAutomationTrigger,
  TableBaseRole,
  TableBaseVisibility,
  TableCardSpec,
  TableDashboardConfig,
  TableDashboardWidgetType,
  TableFieldType,
  TableFormAudience,
  TableFormConfig,
  TableRecordValues,
  TableSchemaSnapshot,
  TableViewScope,
  TableViewType,
} from './tables.js';
import type {
  TableAccessSchemaFacts,
  TableBaseAccessView,
  TableBaseGroupMemberView,
  TableBaseMemberRole,
  TableBaseRoleView,
  TableRoleReferences,
  TableTeamRole,
} from './table-access.js';
import type { TableCardResult } from './table-cards.js';

// ─── Bases ────────────────────────────────────────────────

export interface TableBase {
  id: number;
  name: string;
  description: string | null;
  visibility: TableBaseVisibility;
  owner_id: string;
  team_role: TableTeamRole;
  team_custom_role_id: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface TableBaseWithRole extends TableBase {
  role: TableBaseRole;
}

export interface TableBaseMember {
  id: number;
  base_id: number;
  user_id: string;
  role: TableBaseMemberRole;
  custom_role_id: number | null;
  added_by: string;
  created_at: string;
  updated_at: string;
}

export interface TableBaseWorkspace {
  base: TableBase;
  /** The built-in role this reads as (a custom role reads as viewer — see `access`). */
  role: TableBaseRole;
  /** The effective access; for a custom role, its compiled per-table view. */
  access: TableBaseAccessView;
  /** For a custom role: only the tables it has a rule for. */
  tables: TableDefinition[];
  dashboards: TableDashboard[];
  /** People with a direct grant, names only. Grants themselves: `TableBaseAccessList` (owner). */
  members: Array<{ id: string; name: string }>;
}

/** One internal account from the Tables user directory. */
export interface TableUser {
  id: string;
  nickname: string;
  email: string;
  role: 'team' | 'super';
}

/** What editors, filters and renderers need from a user. */
export type TableUserOption = Pick<TableUser, 'id' | 'nickname' | 'email'>;

/** One platform audit event of a Base's feed (writes only; `scope_*` = the Base it was recorded under). */
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
  scope_type: string | null;
  scope_id: string | null;
  action_id: string;
  capability: string;
  result: 'success' | 'denied' | 'error';
  summary: string;
  created_at: string;
}

// ─── Access ───────────────────────────────────────────────

/** A person's grant with their display name. */
export type TableBaseMemberGrant = TableBaseMember & { name: string };

export interface TableBaseAccessList {
  members: TableBaseMemberGrant[];
  groups: TableBaseGroupMemberView[];
  /** Owner / super only. */
  roles?: TableBaseRoleView[];
}

export interface TableBaseRoleList {
  roles: TableBaseRoleView[];
  references: Array<TableRoleReferences & { roleId: number }>;
  /** Tables, fields and dependency edges — what `computeFieldAccess` needs in the rule editor. */
  facts: TableAccessSchemaFacts;
}

// ─── Schema ───────────────────────────────────────────────

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
  /** JSON-encoded `TableFieldConfig`. */
  config: string;
  position: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface TableSchema {
  table: TableDefinition;
  fields: TableField[];
  views: TableView[];
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

// ─── Views ────────────────────────────────────────────────

export interface TableView {
  id: number;
  table_id: number;
  name: string;
  type: TableViewType;
  scope: TableViewScope;
  owner_id: string | null;
  /** JSON-encoded `TableViewConfig`. */
  config: string;
  position: number;
  revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// ─── Records ──────────────────────────────────────────────

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

export interface TableRecordPage {
  records: TableRecord[];
  total: number;
  nextCursor: string | null;
}

/** One pasted / batched row's pre-check. */
export type TableBatchValidation = {
  index: number;
  ok: boolean;
  reason?: 'not_found' | 'conflict' | 'invalid';
  message?: string;
  current?: number;
};

// ─── Forms ────────────────────────────────────────────────

export interface TableForm {
  id: number;
  table_id: number;
  name: string;
  status: 'draft' | 'published';
  config: TableFormConfig;
  audience: TableFormAudience;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

// ─── Automations ──────────────────────────────────────────

export interface TableAutomation {
  id: number;
  base_id: number;
  table_id: number;
  name: string;
  status: 'disabled' | 'enabled';
  trigger: TableAutomationTrigger;
  config: TableAutomationConfig;
  /** Who the rule runs as: whoever last saved what it does. */
  execution_user_id: string;
  revision: number;
  next_fire_at: string | null;
  swept_until: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface TableAutomationRun {
  id: number;
  rule_id: number;
  outbox_id: number | null;
  status: TableAutomationRunStatus;
  actions_completed: number;
  /** A `TableAutomationRunError` code, or a raw message. */
  error: string | null;
  steps: TableAutomationRunStep[];
  trigger_kind: TableAutomationTrigger | null;
  record_id: number | null;
  started_at: string;
  finished_at: string | null;
}

// ─── Dashboards ───────────────────────────────────────────

export interface TableDashboard {
  id: number;
  base_id: number;
  name: string;
  description: string | null;
  /** `{version, filters}` — rows written before filters existed hold `{}`. */
  config: TableDashboardConfig;
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
  /** JSON-encoded `TableDashboardWidgetConfig`. */
  config: string;
  /** JSON-encoded `TableDashboardWidgetLayout`. */
  layout: string;
  position: number;
  revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  /** Set for a restricted reader when the widget's table or query is out of reach (config withheld). */
  access?: 'no_access';
}

/** One evaluated widget: the card as the caller may see it and its result (records are projected). */
export interface TableDashboardWidgetResult {
  widget: TableDashboardWidget;
  card: TableCardSpec | null;
  result: TableCardResult<TableRecordPage>;
}
