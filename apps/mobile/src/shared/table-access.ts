/**
 * VENDORED verbatim from packages/types/src/table-access.ts — apps/mobile is outside the
 * pnpm workspace and cannot import @greenhouse/types. Never edit below this
 * header: change the canonical file and copy it again (table-access.parity.test.ts in
 * the root vitest fails on any drift). Sibling `./x.js` imports resolve to the
 * vendored `./x.ts` (metro.config.js; TypeScript's bundler resolution).
 */

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

import {
  isComputedFieldType,
  TABLE_FILTER_OPERATORS,
  TABLE_SYSTEM_FIELDS,
  type TableBaseRole,
  type TableBaseVisibility,
  type TableFieldType,
  type TableFilterGroup,
  type TableSystemField,
} from './tables.js';

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

// ─── Effective role (the one decision table) ──────────────

/** Where an effective level came from. */
export type TableBaseAccessVia = 'super' | 'owner' | 'member' | 'group' | 'team' | 'none';

/** What deciding one person's level on one Base needs. Callers load it; nobody re-derives the order. */
export interface TableBaseAccessFacts {
  user: { id: string; role: string; status: string } | null | undefined;
  base: {
    owner_id: string;
    visibility: TableBaseVisibility;
    team_role: TableTeamRole;
    team_custom_role_id: number | null;
    archived_at: string | null;
  };
  /** The person's own member row on this Base. */
  member: { role: TableBaseMemberRole; custom_role_id: number | null } | null | undefined;
  /**
   * Grants of the groups the person is listed in (`group_members` rows only —
   * a group's creator is not a member unless listed). Omitted = none.
   */
  groups?: readonly TableBaseGroupGrantFact[] | null;
}

/** One group grant that reaches the person. */
export interface TableBaseGroupGrantFact {
  role: TableGroupMemberRole;
  custom_role_id: number | null;
  /** The referenced role's `position` on this Base; null when the reference dangles. */
  custom_role_position: number | null;
}

export interface TableBaseAccessDecision {
  level: TableBaseAccessLevel;
  via: TableBaseAccessVia;
  /** level = custom: the role the caller must load (same Base). A role that fails to load means `none`. */
  customRoleId?: number;
}

const NO_BASE_ACCESS: TableBaseAccessDecision = Object.freeze({ level: 'none', via: 'none' });

/**
 * The effective-role order (spec §1, D2 / D13). Pure, so the API's
 * `platform/tables/access.ts` and the db automation executor check decide the
 * same way from the same facts:
 *
 * 1. inactive / non-internal user, or an archived Base → none;
 * 2. super, or the Base owner → owner;
 * 3. the person's own member row, even when it is lower than a group or team grant;
 * 4. group grants: editor > custom > viewer (never builder — D12); among custom
 *    grants the role with the smallest `position` wins. A custom grant whose
 *    role is gone still outranks viewer and resolves to none (D13);
 * 5. a team-visible Base → its `team_role`;
 * 6. otherwise none.
 *
 * `custom` without a role id is a dangling reference and resolves to none, never viewer.
 */
export function decideTableBaseAccess(facts: TableBaseAccessFacts): TableBaseAccessDecision {
  const { user, base, member } = facts;
  if (!user || user.status !== 'active' || (user.role !== 'team' && user.role !== 'super')) return NO_BASE_ACCESS;
  if (base.archived_at) return NO_BASE_ACCESS;
  if (user.role === 'super') return { level: 'owner', via: 'super' };
  if (base.owner_id === user.id) return { level: 'owner', via: 'owner' };
  if (member) {
    if (member.role !== 'custom') return { level: member.role, via: 'member' };
    return member.custom_role_id
      ? { level: 'custom', via: 'member', customRoleId: member.custom_role_id }
      : NO_BASE_ACCESS;
  }
  const viaGroup = decideGroupGrants(facts.groups);
  if (viaGroup) return viaGroup;
  if (base.visibility === 'team') {
    if (base.team_role !== 'custom') return { level: base.team_role, via: 'team' };
    return base.team_custom_role_id
      ? { level: 'custom', via: 'team', customRoleId: base.team_custom_role_id }
      : NO_BASE_ACCESS;
  }
  return NO_BASE_ACCESS;
}

/** The strongest group grant, or undefined when no group reaches the person. */
function decideGroupGrants(
  groups: readonly TableBaseGroupGrantFact[] | null | undefined,
): TableBaseAccessDecision | undefined {
  if (!groups || groups.length === 0) return undefined;
  if (groups.some((grant) => grant.role === 'editor')) return { level: 'editor', via: 'group' };
  const customs = groups.filter((grant) => grant.role === 'custom');
  if (customs.length > 0) {
    const loadable = customs
      .filter((grant): grant is TableBaseGroupGrantFact & { custom_role_id: number } => grant.custom_role_id !== null)
      .sort(
        (a, b) =>
          (a.custom_role_position ?? Number.MAX_SAFE_INTEGER) - (b.custom_role_position ?? Number.MAX_SAFE_INTEGER) ||
          a.custom_role_id - b.custom_role_id,
      );
    // Every custom grant dangles: still custom (it outranks viewer), so none.
    return loadable[0] ? { level: 'custom', via: 'group', customRoleId: loadable[0].custom_role_id } : NO_BASE_ACCESS;
  }
  return groups.some((grant) => grant.role === 'viewer') ? { level: 'viewer', via: 'group' } : undefined;
}

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
  /**
   * D14 — where a scoped writer's relation values may point: the read rows of
   * each target table it has a rule for. A relation whose target table is not
   * listed accepts no new record ids (the compiler also keeps it read-only).
   * Absent = no target is reachable.
   */
  relationTargets?: TableRelationTargetScope[];
}

/** The read rows a scoped writer may link to on one relation target table. */
export interface TableRelationTargetScope {
  tableId: number;
  /** Every scope must hold. Empty = all rows. */
  rows: TableRowScope[];
}

/** Required on every record read, write and aggregate (never optional — see the scope guard test). */
export type TableAccessScope = TableFullScope | TableDataScope;

export function fullTableAccess(userId: string | null): TableFullScope {
  return { kind: 'full', userId };
}

// ─── Wire views ───────────────────────────────────────────

export interface TableBaseAccessView {
  level: TableBaseAccessLevel;
  /** Present when level = custom. */
  customRole?: { id: number; name: string };
  /**
   * Never sent to a restricted person: raw rules would show them row predicates
   * and the ids of fields hidden from them. `tables` carries what a client needs.
   */
  rules?: TableAccessRules;
  /**
   * Present when level = custom: per visible table, exactly what the server
   * compiled (the same compiler every record call uses), so a client hides what
   * the server would refuse anyway.
   */
  tables?: TableAccessTableView[];
}

/** One table as a restricted person sees it: the compiled scope minus its row predicates. */
export interface TableAccessTableView {
  tableId: number;
  access: 'read' | 'edit';
  readableFieldIds: number[];
  editableFieldIds: number[];
  canCreate: boolean;
  canDelete: boolean;
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

/** How many grants point at a role. `deleteRole` refuses (409 `role_in_use`) while any is non-zero. */
export interface TableRoleReferences {
  users: number;
  groups: number;
  team: boolean;
}

export function roleInUse(references: TableRoleReferences): boolean {
  return references.users > 0 || references.groups > 0 || references.team;
}

// ─── Schema facts ─────────────────────────────────────────

/** A field as the access compiler sees it. */
export interface TableAccessFieldFact {
  id: number;
  tableId: number;
  type: TableFieldType;
  /** Relation fields: the linked table. */
  relationTargetTableId?: number | null;
  /** Display only (the rule editor); the compiler never reads these. */
  name?: string;
  isPrimary?: boolean;
}

/** One `table_field_dependencies` edge: `fieldId` is computed from `dependsOnFieldId` (any table). */
export interface TableFieldDependencyFact {
  fieldId: number;
  dependsOnFieldId: number;
}

/**
 * What compiling a Base's rules needs: its live tables, their active fields and
 * the dependency edges of computed fields. Loaded by the server
 * (`db.tables.loadAccessFacts`) and handed to the owner's rule editor, so both
 * compute field access with the same function from the same facts.
 */
export interface TableAccessSchemaFacts {
  tables: ReadonlyArray<{ id: number; name?: string }>;
  fields: readonly TableAccessFieldFact[];
  dependencies: readonly TableFieldDependencyFact[];
}

// ─── Normalization (shape only) ───────────────────────────

const MAX_RULE_TABLES = 100;
const MAX_RULE_FIELDS = 500;
const MAX_SCOPE_FIELDS = 20;
const MAX_SCOPE_CLAUSES = 20;

export type NormalizeAccessRulesResult = { ok: true; rules: TableAccessRules } | { ok: false; error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

type RowScopeClause = TableFilterGroup['clauses'][number];

function normalizeClause(raw: unknown): RowScopeClause | string {
  if (!isObject(raw)) return 'each row-scope clause must be an object';
  if (!(TABLE_FILTER_OPERATORS as readonly unknown[]).includes(raw.operator)) {
    return 'row-scope clause operator is invalid';
  }
  const operator = raw.operator as RowScopeClause['operator'];
  const value = raw.value === undefined ? {} : { value: raw.value };
  if (raw.fieldId !== undefined && raw.systemField === undefined) {
    return isId(raw.fieldId) ? { fieldId: raw.fieldId, operator, ...value } : 'row-scope clause fieldId is invalid';
  }
  if (raw.systemField !== undefined && raw.fieldId === undefined) {
    return (TABLE_SYSTEM_FIELDS as readonly unknown[]).includes(raw.systemField)
      ? { systemField: raw.systemField as TableSystemField, operator, ...value }
      : 'row-scope clause systemField is invalid';
  }
  return 'each row-scope clause needs exactly one of fieldId / systemField';
}

/** A row scope's shape. Field references stay whatever they point at — the compiler fails them closed. */
function normalizeRowScope(raw: unknown, label: string): TableRowScope | string {
  if (!isObject(raw)) return `${label} must be an object`;
  if (raw.type === 'all') return { type: 'all' };
  if (raw.type === 'related') {
    if (raw.creator !== undefined && typeof raw.creator !== 'boolean') return `${label}.creator must be a boolean`;
    const fieldIds = raw.fieldIds ?? [];
    if (!Array.isArray(fieldIds) || fieldIds.length > MAX_SCOPE_FIELDS || !fieldIds.every(isId)) {
      return `${label}.fieldIds must be up to ${MAX_SCOPE_FIELDS} field ids`;
    }
    const creator = raw.creator === true;
    if (!creator && fieldIds.length === 0) return `${label} must name the creator or at least one person field`;
    return { type: 'related', creator, fieldIds: [...new Set(fieldIds)] };
  }
  if (raw.type === 'where') {
    const where = raw.where;
    if (!isObject(where) || (where.combinator !== 'and' && where.combinator !== 'or')) {
      return `${label}.where must be a filter group`;
    }
    if (!Array.isArray(where.clauses) || where.clauses.length === 0 || where.clauses.length > MAX_SCOPE_CLAUSES) {
      return `${label}.where needs 1-${MAX_SCOPE_CLAUSES} clauses`;
    }
    const clauses: RowScopeClause[] = [];
    for (const clause of where.clauses) {
      const normalized = normalizeClause(clause);
      if (typeof normalized === 'string') return `${label}: ${normalized}`;
      clauses.push(normalized);
    }
    return { type: 'where', where: { combinator: where.combinator, clauses } };
  }
  return `${label}.type must be all, related or where`;
}

function normalizeRule(raw: unknown, index: number): TableAccessRule | string {
  const label = `tables[${index}]`;
  if (!isObject(raw)) return `${label} must be an object`;
  if (!isId(raw.tableId)) return `${label}.tableId is invalid`;
  if (raw.access !== 'read' && raw.access !== 'edit') return `${label}.access must be read or edit`;
  if (raw.fieldDefault !== 'visible' && raw.fieldDefault !== 'hidden') {
    return `${label}.fieldDefault must be visible or hidden`;
  }
  const entries = raw.fields ?? [];
  if (!Array.isArray(entries) || entries.length > MAX_RULE_FIELDS) {
    return `${label}.fields must be a list of up to ${MAX_RULE_FIELDS} entries`;
  }
  const fields: TableAccessRule['fields'] = [];
  const seen = new Set<number>();
  for (const entry of entries) {
    if (!isObject(entry) || !isId(entry.fieldId)) return `${label}.fields entries need a fieldId`;
    if (entry.access !== 'hidden' && entry.access !== 'read' && entry.access !== 'edit') {
      return `${label}.fields access must be hidden, read or edit`;
    }
    if (seen.has(entry.fieldId)) return `${label}.fields lists field ${entry.fieldId} twice`;
    seen.add(entry.fieldId);
    fields.push({ fieldId: entry.fieldId, access: entry.access });
  }
  const rule: TableAccessRule = { tableId: raw.tableId, access: raw.access, fields, fieldDefault: raw.fieldDefault };
  for (const key of ['rows', 'editRows'] as const) {
    if (raw[key] === undefined) continue;
    const scope = normalizeRowScope(raw[key], `${label}.${key}`);
    if (typeof scope === 'string') return scope;
    rule[key] = scope;
  }
  for (const key of ['create', 'delete'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'boolean') return `${label}.${key} must be a boolean`;
    rule[key] = raw[key];
  }
  return rule;
}

/**
 * Validate a rules document's shape and, given the Base's `schema`, drop rules
 * for tables that are not in it (a dropped rule hides that table — it can
 * never widen access). Without `schema` (re-checking stored rules) every rule
 * is kept. Never drops or rewrites a row predicate, and keeps field entries
 * even for fields that no longer exist (a restored field must come back hidden
 * rather than fall through to `fieldDefault`): dangling references are the
 * compiler's business, and it fails them closed.
 */
export function normalizeAccessRules(
  raw: unknown,
  schema?: { tables: ReadonlyArray<{ id: number }> },
): NormalizeAccessRulesResult {
  if (!isObject(raw)) return { ok: false, error: 'rules must be an object' };
  if (raw.version !== 1) return { ok: false, error: 'rules.version must be 1' };
  if (raw.dashboards !== 'all' && raw.dashboards !== 'none') {
    return { ok: false, error: 'rules.dashboards must be all or none' };
  }
  if (!Array.isArray(raw.tables) || raw.tables.length > MAX_RULE_TABLES) {
    return { ok: false, error: `rules.tables must be a list of up to ${MAX_RULE_TABLES} rules` };
  }
  const known = schema ? new Set(schema.tables.map((table) => table.id)) : null;
  const tables: TableAccessRule[] = [];
  const seen = new Set<number>();
  for (const [index, entry] of raw.tables.entries()) {
    const rule = normalizeRule(entry, index);
    if (typeof rule === 'string') return { ok: false, error: rule };
    if (seen.has(rule.tableId)) return { ok: false, error: `rules.tables lists table ${rule.tableId} twice` };
    seen.add(rule.tableId);
    if (!known || known.has(rule.tableId)) tables.push(rule);
  }
  return { ok: true, rules: { version: 1, tables, dashboards: raw.dashboards } };
}

// ─── Field access ─────────────────────────────────────────

const FIELD_ACCESS_RANK: Readonly<Record<TableFieldAccess, number>> = { hidden: 0, read: 1, edit: 2 };

function minAccess(a: TableFieldAccess, b: TableFieldAccess): TableFieldAccess {
  return FIELD_ACCESS_RANK[a] <= FIELD_ACCESS_RANK[b] ? a : b;
}

/**
 * The access a rule declares for one field, before dependencies: its explicit
 * entry, else `fieldDefault` (visible = whatever the table rule allows), capped
 * by the table rule (`read` never edits). No rule = hidden.
 */
export function fieldAccessFor(rule: TableAccessRule | undefined, fieldId: number): TableFieldAccess {
  if (!rule) return 'hidden';
  const entry = rule.fields.find((field) => field.fieldId === fieldId);
  const declared: TableFieldAccess = entry ? entry.access : rule.fieldDefault === 'visible' ? 'edit' : 'hidden';
  return rule.access === 'read' ? minAccess(declared, 'read') : declared;
}

/** A field's effective access, and why it is stricter than declared. */
export interface TableEffectiveFieldAccess {
  access: TableFieldAccess;
  /**
   * `dependency_hidden`: a computed field hidden because something it is computed
   * from is hidden (D4). `relation_target_hidden`: a relation kept read-only
   * because the role cannot see its target table (D14).
   */
  reason?: 'dependency_hidden' | 'relation_target_hidden';
}

/**
 * Effective access of every field in `facts` under `rules`:
 * - declared access (`fieldAccessFor`); a table without a rule hides its fields;
 * - computed fields (formula / rollup / lookup) are at most `read`, and hidden
 *   when anything in their dependency closure is hidden — same-table sources,
 *   and for rollup / lookup the relation plus the target field under the role's
 *   rule for the target table (no rule there = hidden). Unknown or cyclic
 *   dependencies hide. Values stay computed over all rows (D4);
 * - a relation is at most `read` when the role has no rule for its target table.
 */
export function computeFieldAccess(
  rules: TableAccessRules,
  facts: TableAccessSchemaFacts,
): Map<number, TableEffectiveFieldAccess> {
  const fields = new Map(facts.fields.map((field) => [field.id, field]));
  const dependsOn = new Map<number, number[]>();
  for (const edge of facts.dependencies) {
    dependsOn.set(edge.fieldId, [...(dependsOn.get(edge.fieldId) ?? []), edge.dependsOnFieldId]);
  }
  const ruleFor = new Map(rules.tables.map((rule) => [rule.tableId, rule]));
  const result = new Map<number, TableEffectiveFieldAccess>();
  const visiting = new Set<number>();

  const resolve = (fieldId: number): TableEffectiveFieldAccess => {
    const done = result.get(fieldId);
    if (done) return done;
    const field = fields.get(fieldId);
    if (!field || visiting.has(fieldId)) return { access: 'hidden' };
    visiting.add(fieldId);
    const declared = fieldAccessFor(ruleFor.get(field.tableId), field.id);
    let effective: TableEffectiveFieldAccess = { access: declared };
    if (isComputedFieldType(field.type)) {
      effective = { access: minAccess(declared, 'read') };
      const sources = dependsOn.get(field.id) ?? [];
      if (effective.access !== 'hidden' && sources.some((source) => resolve(source).access === 'hidden')) {
        effective = { access: 'hidden', reason: 'dependency_hidden' };
      }
    } else if (field.type === 'relation' && declared === 'edit') {
      const target = field.relationTargetTableId;
      if (!target || !ruleFor.has(target)) effective = { access: 'read', reason: 'relation_target_hidden' };
    }
    visiting.delete(fieldId);
    result.set(fieldId, effective);
    return effective;
  };

  for (const field of facts.fields) resolve(field.id);
  return result;
}

// ─── Compile ──────────────────────────────────────────────

function isAllRows(scope: TableRowScope | undefined): scope is undefined | { type: 'all' } {
  return scope === undefined || (isObject(scope) && scope.type === 'all');
}

/**
 * The one rules → scope compiler (Base custom roles now, app roles in Phase 1):
 * the rule for `tableId` becomes the `TableDataScope` every db record call
 * enforces. Undefined when the role has no rule for the table (invisible).
 * Pass `fieldAccess` to reuse one closure pass across tables.
 */
export function compileTableAccessScope(
  rules: TableAccessRules,
  tableId: number,
  facts: TableAccessSchemaFacts,
  userId: string,
  fieldAccess: ReadonlyMap<number, TableEffectiveFieldAccess> = computeFieldAccess(rules, facts),
): TableDataScope | undefined {
  const rule = ruleForTable(rules, tableId);
  if (!rule) return undefined;
  const fields = facts.fields.filter((field) => field.tableId === tableId);
  const accessOf = (fieldId: number) => fieldAccess.get(fieldId)?.access ?? 'hidden';
  const editable = rule.access === 'edit' ? fields.filter((field) => accessOf(field.id) === 'edit') : [];
  const relationTargets: TableRelationTargetScope[] = [];
  for (const field of editable) {
    if (field.type !== 'relation') continue;
    const target = ruleForTable(rules, field.relationTargetTableId ?? 0);
    if (target && !relationTargets.some((entry) => entry.tableId === target.tableId)) {
      relationTargets.push({ tableId: target.tableId, rows: isAllRows(target.rows) ? [] : [target.rows] });
    }
  }
  return {
    kind: 'scoped',
    userId,
    tableId,
    rows: isAllRows(rule.rows) ? [] : [rule.rows],
    editRows: isAllRows(rule.editRows) ? [] : [rule.editRows],
    readableFieldIds: fields.filter((field) => accessOf(field.id) !== 'hidden').map((field) => field.id),
    editableFieldIds: editable.map((field) => field.id),
    canCreate: rule.access === 'edit' && rule.create !== false,
    canDelete: rule.access === 'edit' && rule.delete === true,
    relationTargets,
  };
}

/** The wire view of a compiled scope (`getBase.access.tables`): no row predicates. */
export function accessTableView(rule: TableAccessRule, scope: TableDataScope): TableAccessTableView {
  return {
    tableId: scope.tableId,
    access: rule.access,
    readableFieldIds: scope.readableFieldIds,
    editableFieldIds: scope.editableFieldIds,
    canCreate: scope.canCreate,
    canDelete: scope.canDelete,
  };
}
