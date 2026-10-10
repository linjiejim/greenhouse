/**
 * Tables access contracts — Base roles, custom roles (row / field rules) and the
 * compiled data scope every record read and write carries.
 *
 * One rule shape serves two consumers: a Base's custom roles (Phase 0) and app
 * roles (Phase 1). Both compile through the same server compiler, so "what a
 * restricted person may see" has exactly one implementation.
 *
 * Dependency-free apart from `./tables` (vendored verbatim into the mobile app).
 */

import type { TableBaseRole, TableFilterGroup } from './tables.js';

// ─── Roles ────────────────────────────────────────────────

/** The only rank table. Built-in roles only: `custom` is not ranked against them. */
export const TABLE_BASE_ROLE_RANK: Readonly<Record<TableBaseRole, number>> = Object.freeze({
  viewer: 1,
  editor: 2,
  builder: 3,
  owner: 4,
});

export function tableRoleAtLeast(role: TableBaseRole, required: TableBaseRole): boolean {
  return TABLE_BASE_ROLE_RANK[role] >= TABLE_BASE_ROLE_RANK[required];
}

/** What a member row (user or group) may hold. Groups can never be builders. */
export type TableBaseMemberRole = TableBaseRole | 'custom';
export type TableGroupMemberRole = 'editor' | 'viewer' | 'custom';
/** The role every internal user gets on a team-visible Base. */
export type TableTeamRole = 'viewer' | 'editor' | 'custom';

/** The effective level of one person on one Base. `none` surfaces as 404. */
export type TableBaseAccessLevel = TableBaseRole | 'custom' | 'none';

// ─── Rules ────────────────────────────────────────────────

/**
 * Which rows a rule covers.
 * - `related`: records I created (`creator`) or whose listed user / multi_user fields contain me.
 * - `where`: a filter group; user clauses may use `$me`.
 * A predicate that references a missing / archived / wrong-type field compiles
 * to FALSE (fail closed) — normalization never drops a predicate.
 */
export type TableRowScope =
  | { type: 'all' }
  | { type: 'related'; creator: boolean; fieldIds: number[] }
  | { type: 'where'; where: TableFilterGroup };

export type TableFieldAccess = 'hidden' | 'read' | 'edit';

export interface TableAccessRule {
  tableId: number;
  access: 'read' | 'edit';
  /** Rows this role reads. Default all. */
  rows?: TableRowScope;
  /** Rows this role may update / delete, ANDed with `rows`. Default = rows. */
  editRows?: TableRowScope;
  /** Explicit per-field access; fields not listed follow `fieldDefault`. */
  fields: Array<{ fieldId: number; access: TableFieldAccess }>;
  /**
   * Required. `hidden` (the editor's default) means a field added later stays
   * hidden from this role until someone opts it in.
   */
  fieldDefault: 'visible' | 'hidden';
  /** access=edit: default true. */
  create?: boolean;
  /** Default false. */
  delete?: boolean;
}

export interface TableAccessRules {
  version: 1;
  /** A table with no rule is invisible to the role. */
  tables: TableAccessRule[];
  dashboards: 'all' | 'none';
}

export const EMPTY_TABLE_ACCESS_RULES: Readonly<TableAccessRules> = Object.freeze({
  version: 1,
  tables: [],
  dashboards: 'none',
});

export function ruleForTable(rules: TableAccessRules, tableId: number): TableAccessRule | undefined {
  return rules.tables.find((rule) => rule.tableId === tableId);
}

// ─── Compiled scope ───────────────────────────────────────

/**
 * Full access, still carrying the acting user so `$me` tokens in saved views and
 * dashboard filters resolve. Automations, imports and recompute pass the
 * executor (or null — then `$me` matches nothing).
 */
export interface TableFullScope {
  kind: 'full';
  userId: string | null;
}

/**
 * A restricted principal's view of one table, compiled from a rule (Base custom
 * role, or an app role intersected with a card). Row scopes are ANDed.
 */
export interface TableDataScope {
  kind: 'scoped';
  userId: string;
  tableId: number;
  /** Read rows: every scope must hold. Empty = all rows. */
  rows: TableRowScope[];
  /** Additionally required for update / delete. */
  editRows: TableRowScope[];
  readableFieldIds: number[];
  editableFieldIds: number[];
  canCreate: boolean;
  canDelete: boolean;
}

/** Required on every record read, write and aggregate (never optional — see the scope guard test). */
export type TableAccessScope = TableFullScope | TableDataScope;

export function fullTableAccess(userId: string | null): TableFullScope {
  return { kind: 'full', userId };
}

export function isFullTableAccess(scope: TableAccessScope): scope is TableFullScope {
  return scope.kind === 'full';
}

// ─── Wire views ───────────────────────────────────────────

export interface TableBaseAccessView {
  level: TableBaseAccessLevel;
  /** Present when level = custom. */
  customRole?: { id: number; name: string };
  /** Present when level = custom: the rules the client uses to hide what the server will refuse anyway. */
  rules?: TableAccessRules;
}

export interface TableBaseRoleView {
  id: number;
  baseId: number;
  name: string;
  description: string | null;
  rules: TableAccessRules;
  position: number;
  revision: number;
}

export interface TableBaseGroupMemberView {
  groupId: number;
  name: string;
  role: TableGroupMemberRole;
  customRoleId: number | null;
  memberCount: number;
  /** Who controls this group's membership — shown so owners know whom they delegate to. */
  managedBy: { id: string; name: string } | null;
}
