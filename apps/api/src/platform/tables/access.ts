/**
 * Tables access — the one place a person's standing on a Base is resolved.
 *
 * Two layers, always in this order:
 *  1. the Platform Kernel is the outer ceiling: the action's capability (checked
 *     by `runtime.dispatch`), the entity scope, and the `record.values` field
 *     policy;
 *  2. the Tables domain decides the effective Base level
 *     (`decideTableBaseAccess`: super / owner → own member row → groups →
 *     team default) and, for record data, the scope every db record method takes.
 *
 * Everything that asks "may this person see / change this Base or record" goes
 * through here: handlers (`requireBase` / `requireTableData`), Drive, the
 * realtime fan-out and notification recipients (`canRecipientRead`). Never
 * re-derive a role from member rows anywhere else.
 *
 * Custom roles: the role is loaded from the same Base only (a dangling or
 * foreign reference resolves to `none`, never viewer — D13) and compiled per
 * table with `compileTableAccessScope` from `@greenhouse/types/table-access`,
 * the one compiler Phase 1 app roles reuse. `customAccessLens` exposes the
 * compiled view to handlers that trim structure (`./access-trim.ts`).
 */

import {
  canAccessRecord,
  effectiveUserId,
  fieldPolicyFor,
  resolveEntityPolicy,
  type ActorContext,
  type EntityPolicy,
  type PlatformActionRequest,
} from '@greenhouse/platform-kernel';
import {
  projectTableRecord,
  type DatabaseProvider,
  type TableBaseMemberRow,
  type TableBaseRow,
  type TableRecordRow,
  type TableUserGroupGrantRow,
  type UserRow,
} from '@greenhouse/db';
import {
  accessTableView,
  compileTableAccessScope,
  computeFieldAccess,
  decideTableBaseAccess,
  fullTableAccess,
  normalizeAccessRules,
  ruleForTable,
  tableRoleAtLeast,
  type TableAccessRule,
  type TableAccessRules,
  type TableAccessSchemaFacts,
  type TableAccessScope,
  type TableBaseAccessDecision,
  type TableBaseAccessView,
  type TableDataScope,
  type TableEffectiveFieldAccess,
} from '@greenhouse/types/table-access';
import type { TableBaseRole } from '@greenhouse/types/tables';
import { humanActor } from '../actor.js';
import { tablesManifest } from '../manifests/tables.js';
import { getPlatformRuntime, type PlatformHandlerContext } from '../runtime.js';
import { appReachForRecord } from './app-audience.js';

type AccessContext = Pick<PlatformHandlerContext, 'db'>;
type AccessUser = Pick<UserRow, 'id' | 'role' | 'status'>;
type RecordRef = Pick<TableRecordRow, 'id' | 'table_id'>;

/** A Base level plus, for `custom`, the loaded role (always of this Base). */
export interface ResolvedBaseAccess extends TableBaseAccessDecision {
  customRole?: { id: number; baseId: number; name: string; rules: TableAccessRules };
}

const NO_ACCESS: ResolvedBaseAccess = Object.freeze({ level: 'none', via: 'none' });

// ─── Resource → Base ──────────────────────────────────────

export async function baseForTable(db: DatabaseProvider, tableId: number): Promise<TableBaseRow | undefined> {
  const table = await db.tables.getTable(tableId);
  return table ? db.tables.getBase(table.base_id) : undefined;
}

export async function baseForField(db: DatabaseProvider, fieldId: number): Promise<TableBaseRow | undefined> {
  const field = await db.tables.getField(fieldId);
  return field ? baseForTable(db, field.table_id) : undefined;
}

export async function baseForForm(db: DatabaseProvider, formId: number): Promise<TableBaseRow | undefined> {
  const form = await db.tables.getForm(formId);
  return form ? baseForTable(db, form.table_id) : undefined;
}

export async function baseForAutomation(db: DatabaseProvider, automationId: number): Promise<TableBaseRow | undefined> {
  const automation = await db.tables.getAutomationRule(automationId);
  return automation ? db.tables.getBase(automation.base_id) : undefined;
}

export async function baseForDashboard(db: DatabaseProvider, dashboardId: number): Promise<TableBaseRow | undefined> {
  const dashboard = await db.tables.getDashboard(dashboardId);
  return dashboard ? db.tables.getBase(dashboard.dashboard.base_id) : undefined;
}

export async function baseForWidget(db: DatabaseProvider, widgetId: number): Promise<TableBaseRow | undefined> {
  const widget = await db.tables.getDashboardWidget(widgetId);
  return widget ? baseForDashboard(db, widget.dashboard_id) : undefined;
}

export async function baseForRole(db: DatabaseProvider, roleId: number): Promise<TableBaseRow | undefined> {
  const role = await db.tables.getBaseRole(roleId);
  return role ? db.tables.getBase(role.base_id) : undefined;
}

// ─── The effective Base level ─────────────────────────────

/**
 * Load the custom role `roleId` for `base`. Undefined — and so no access, never
 * viewer (D13) — when it is gone, belongs to another Base, or its stored rules
 * no longer pass the shape check.
 */
async function loadCustomRole(
  ctx: AccessContext,
  base: TableBaseRow,
  roleId: number,
): Promise<ResolvedBaseAccess['customRole']> {
  const role = await ctx.db.tables.getBaseRole(roleId);
  if (!role || role.base_id !== base.id) return undefined;
  const rules = normalizeAccessRules(role.rules);
  return rules.ok ? { id: role.id, baseId: base.id, name: role.name, rules: rules.rules } : undefined;
}

async function completeDecision(
  ctx: AccessContext,
  base: TableBaseRow,
  decision: TableBaseAccessDecision,
): Promise<ResolvedBaseAccess> {
  if (decision.level !== 'custom' || decision.customRoleId === undefined) {
    return decision.level === 'custom' ? NO_ACCESS : decision;
  }
  const customRole = await loadCustomRole(ctx, base, decision.customRoleId);
  return customRole ? { ...decision, customRole } : NO_ACCESS;
}

/** One person's effective level on one Base (the Tables domain only — no kernel policy). */
export async function resolveBaseAccess(
  ctx: AccessContext,
  user: AccessUser | null | undefined,
  base: TableBaseRow,
): Promise<ResolvedBaseAccess> {
  if (!user) return NO_ACCESS;
  // Super and the owner never depend on a member row or a group.
  if (user.role === 'super' || base.owner_id === user.id) {
    return completeDecision(ctx, base, decideTableBaseAccess({ user, base, member: undefined }));
  }
  const member = await ctx.db.tables.getBaseMember(base.id, user.id);
  // The own member row wins outright; groups are only read when there is none.
  const groups = member ? [] : await ctx.db.tables.listGroupGrantsForUser(base.id, user.id);
  return completeDecision(ctx, base, decideTableBaseAccess({ user, base, member, groups }));
}

/** `resolveBaseAccess` for many people on one Base, with one member-row and one group query. */
export async function resolveBaseAccessForUsers(
  ctx: AccessContext,
  users: readonly AccessUser[],
  base: TableBaseRow,
): Promise<Map<string, ResolvedBaseAccess>> {
  const [memberRows, groupRows] = await Promise.all([
    ctx.db.tables.listBaseMembers(base.id),
    ctx.db.tables.listGroupGrantsForBase(base.id),
  ]);
  const members = new Map<string, TableBaseMemberRow>(memberRows.map((member) => [member.user_id, member]));
  const groupsByUser = new Map<string, TableUserGroupGrantRow[]>();
  for (const grant of groupRows) groupsByUser.set(grant.user_id, [...(groupsByUser.get(grant.user_id) ?? []), grant]);
  const out = new Map<string, ResolvedBaseAccess>();
  for (const user of users) {
    out.set(
      user.id,
      await completeDecision(
        ctx,
        base,
        decideTableBaseAccess({ user, base, member: members.get(user.id), groups: groupsByUser.get(user.id) }),
      ),
    );
  }
  return out;
}

/** The built-in role a level shows as (`getBase.role`). A custom role reads as viewer; its compiled view travels in `access`. */
export function displayRole(access: ResolvedBaseAccess): TableBaseRole | undefined {
  if (access.level === 'none') return undefined;
  return access.level === 'custom' ? 'viewer' : access.level;
}

// ─── Custom roles, compiled ───────────────────────────────

/**
 * A custom role's view of its Base, compiled once: which tables it has a rule
 * for, every field's effective access (dependency closure included) and the
 * per-table scope. Handlers that trim structure use it; record handlers get
 * the same scopes through `requireTableData`.
 */
export interface CustomAccessLens {
  rules: TableAccessRules;
  facts: TableAccessSchemaFacts;
  fieldAccess: ReadonlyMap<number, TableEffectiveFieldAccess>;
  ruleFor(tableId: number): TableAccessRule | undefined;
  /** The compiled scope for `tableId`; undefined = the table is invisible to the role. */
  scopeFor(tableId: number): TableDataScope | undefined;
  /** Field ids the role reads on `tableId` (empty for an invisible table). */
  readable(tableId: number): ReadonlySet<number>;
}

const lensCache = new WeakMap<object, Promise<CustomAccessLens>>();

/** The lens of a custom access (undefined for every other level). Facts load once per resolution. */
export function customAccessLens(
  ctx: AccessContext,
  access: ResolvedBaseAccess,
  userId: string,
): Promise<CustomAccessLens> | undefined {
  const role = access.level === 'custom' ? access.customRole : undefined;
  if (!role) return undefined;
  const cached = lensCache.get(role);
  if (cached) return cached;
  const built = ctx.db.tables.loadAccessFacts(role.baseId).then((facts): CustomAccessLens => {
    const fieldAccess = computeFieldAccess(role.rules, facts);
    const scopes = new Map<number, TableDataScope | undefined>();
    const scopeFor = (tableId: number) => {
      if (!scopes.has(tableId)) {
        scopes.set(tableId, compileTableAccessScope(role.rules, tableId, facts, userId, fieldAccess));
      }
      return scopes.get(tableId);
    };
    return {
      rules: role.rules,
      facts,
      fieldAccess,
      ruleFor: (tableId) => ruleForTable(role.rules, tableId),
      scopeFor,
      readable: (tableId) => new Set(scopeFor(tableId)?.readableFieldIds ?? []),
    };
  });
  lensCache.set(role, built);
  return built;
}

/**
 * The wire form of an access (`getBase.access`). A custom role gets its
 * compiled per-table view (readable / editable fields, create / delete) — not
 * its raw rules, whose row predicates and hidden field ids are not theirs to see.
 */
export async function baseAccessView(
  ctx: AccessContext,
  access: ResolvedBaseAccess,
  userId: string,
): Promise<TableBaseAccessView> {
  const lens = await customAccessLens(ctx, access, userId);
  if (!lens || !access.customRole) return { level: access.level };
  const tables = lens.facts.tables.flatMap((table) => {
    const rule = lens.ruleFor(table.id);
    const scope = lens.scopeFor(table.id);
    return rule && scope ? [accessTableView(rule, scope)] : [];
  });
  return { level: access.level, customRole: { id: access.customRole.id, name: access.customRole.name }, tables };
}

// ─── Kernel ceiling ───────────────────────────────────────

async function entityPolicy(ctx: AccessContext, actor: ActorContext, entityId: string): Promise<EntityPolicy> {
  const snapshot = await ctx.db.platform.getEntityPolicySnapshot({
    orgId: actor.orgId,
    userId: effectiveUserId(actor),
    appId: tablesManifest.id,
    entityId,
  });
  return resolveEntityPolicy(snapshot.rolePolicies, snapshot.userOverride);
}

/** The kernel entity scope over the Base: owner = `own`, a member / group grant = `collaborating`. */
function kernelScopeAllows(actor: ActorContext, base: TableBaseRow, access: ResolvedBaseAccess, policy: EntityPolicy) {
  const collaborating = access.via === 'member' || access.via === 'group';
  return canAccessRecord(
    actor,
    { ownerId: base.owner_id, collaboratorIds: collaborating ? [effectiveUserId(actor)] : [] },
    policy,
  );
}

export interface BaseAccessGrant {
  base: TableBaseRow;
  access: ResolvedBaseAccess;
  /** `displayRole(access)` — never undefined on a grant. */
  role: TableBaseRole;
}

interface BaseGate extends BaseAccessGrant {
  policy: EntityPolicy;
}

/** Domain level + kernel entity scope on one Base. `loaded` lets a caller resolve the user and policy once for many Bases. */
async function gateBase(
  ctx: AccessContext,
  actor: ActorContext,
  base: TableBaseRow,
  entityId: string,
  loaded?: { user: UserRow | undefined; policy: EntityPolicy },
): Promise<BaseGate | undefined> {
  if (base.archived_at) return undefined;
  const [user, policy] = loaded
    ? [loaded.user, loaded.policy]
    : await Promise.all([ctx.db.users.getById(effectiveUserId(actor)), entityPolicy(ctx, actor, entityId)]);
  const access = await resolveBaseAccess(ctx, user, base);
  const role = displayRole(access);
  if (!role || !kernelScopeAllows(actor, base, access, policy)) return undefined;
  return { base, access, role, policy };
}

function meetsRequirement(access: ResolvedBaseAccess, required: TableBaseRole, allowCustom: boolean): boolean {
  if (access.level === 'none') return false;
  if (access.level === 'custom') return required === 'viewer' && allowCustom;
  return tableRoleAtLeast(access.level, required);
}

/**
 * The gate for structure / Base-level handlers. A custom role passes only when
 * the handler declares it (`allowCustom`) and needs no more than viewer; every
 * other handler fails closed for it. Missing, archived and forbidden all return
 * undefined — the caller answers 404 either way.
 */
export async function requireBase(
  ctx: AccessContext,
  actor: ActorContext,
  baseId: number,
  entityId: string,
  required: TableBaseRole,
  options: { allowCustom?: boolean } = {},
): Promise<BaseAccessGrant | undefined> {
  const base = await ctx.db.tables.getBase(baseId);
  if (!base) return undefined;
  return requireLoadedBase(ctx, actor, base, entityId, required, options);
}

/** `requireBase` for a Base row the caller has already read (the same gate, one read fewer). */
export async function requireLoadedBase(
  ctx: AccessContext,
  actor: ActorContext,
  base: TableBaseRow,
  entityId: string,
  required: TableBaseRole,
  options: { allowCustom?: boolean } = {},
): Promise<BaseAccessGrant | undefined> {
  const gate = await gateBase(ctx, actor, base, entityId);
  if (!gate || !meetsRequirement(gate.access, required, options.allowCustom === true)) return undefined;
  return { base: gate.base, access: gate.access, role: gate.role };
}

/** Every listed Base the actor can open, resolving the user and the kernel policy once. */
export async function listBaseGrants(
  ctx: AccessContext,
  actor: ActorContext,
  bases: readonly TableBaseRow[],
): Promise<BaseAccessGrant[]> {
  const [user, policy] = await Promise.all([
    ctx.db.users.getById(effectiveUserId(actor)),
    entityPolicy(ctx, actor, 'base'),
  ]);
  if (!user) return [];
  const grants: BaseAccessGrant[] = [];
  for (const base of bases) {
    const gate = await gateBase(ctx, actor, base, 'base', { user, policy });
    if (gate) grants.push({ base: gate.base, access: gate.access, role: gate.role });
  }
  return grants;
}

// ─── Record data ──────────────────────────────────────────

export type TableDataOp = 'read' | 'create' | 'update' | 'delete';

const BUILT_IN_ROLE_FOR: Readonly<Record<TableDataOp, TableBaseRole>> = {
  read: 'viewer',
  create: 'editor',
  update: 'editor',
  delete: 'editor',
};

export interface TableDataAccess extends BaseAccessGrant {
  /** Pass to every db.tables record read / write / aggregate on this table. */
  scope: TableAccessScope;
  /** What the caller may read of a returned record: `scope`, capped by the kernel `record.values` read policy. */
  readScope: TableAccessScope;
  /** `projectTableRecord(row, readScope)` — apply to every record a handler returns. */
  project<T extends Pick<TableRecordRow, 'values' | 'computed_values'>>(row: T): T;
}

/** A scope that sees rows but no field values (kernel `record.values` read = masked). */
function valuelessScope(userId: string, tableId: number): TableDataScope {
  return {
    kind: 'scoped',
    userId,
    tableId,
    rows: [],
    editRows: [],
    readableFieldIds: [],
    editableFieldIds: [],
    canCreate: false,
    canDelete: false,
  };
}

/**
 * A custom role's scope on `tableId` for `op`: undefined when the role has no
 * rule for the table, or the rule does not allow `op` (a read rule never
 * writes; create / delete need the rule's switches). Undefined answers 404,
 * exactly like a built-in viewer asking to write.
 */
async function customTableScope(
  ctx: AccessContext,
  access: ResolvedBaseAccess,
  tableId: number,
  op: TableDataOp,
  userId: string,
): Promise<TableDataScope | undefined> {
  const lens = await customAccessLens(ctx, access, userId);
  const rule = lens?.ruleFor(tableId);
  const scope = lens?.scopeFor(tableId);
  if (!rule || !scope) return undefined;
  if (op === 'read') return scope;
  if (rule.access !== 'edit') return undefined;
  if (op === 'create' && !scope.canCreate) return undefined;
  if (op === 'delete' && !scope.canDelete) return undefined;
  return scope;
}

async function tableDataAccess(
  ctx: AccessContext,
  actor: ActorContext,
  tableId: number,
  op: TableDataOp,
  options: { allowMaskedValues?: boolean },
): Promise<TableDataAccess | undefined> {
  const base = await baseForTable(ctx.db, tableId);
  if (!base) return undefined;
  const gate = await gateBase(ctx, actor, base, 'record');
  if (!gate) return undefined;

  // Kernel `record.values` ceiling, unchanged from before the split: writes need
  // write; a single-record read accepts masked (values come back empty); every
  // query, aggregate and delete needs full read, so filters cannot become an oracle.
  const values = fieldPolicyFor(gate.policy, 'values');
  if (op === 'create' || op === 'update') {
    if (!values.write) return undefined;
  } else if (values.read !== 'full' && !(op === 'read' && options.allowMaskedValues && values.read === 'masked')) {
    return undefined;
  }

  const userId = effectiveUserId(actor);
  let scope: TableAccessScope;
  if (gate.access.level === 'custom') {
    const compiled = await customTableScope(ctx, gate.access, tableId, op, userId);
    if (!compiled) return undefined;
    scope = compiled;
  } else {
    if (gate.access.level === 'none' || !tableRoleAtLeast(gate.access.level, BUILT_IN_ROLE_FOR[op])) return undefined;
    scope = fullTableAccess(userId);
  }
  const readScope = values.read === 'full' ? scope : valuelessScope(userId, tableId);
  return {
    base: gate.base,
    access: gate.access,
    role: gate.role,
    scope,
    readScope,
    project: (row) => projectTableRecord(row, readScope),
  };
}

/**
 * The gate for record-data handlers: Base level for `op` (built-ins: read =
 * viewer, writes = editor; custom: the role's rule), the kernel ceiling, and
 * the scope to hand to db.tables. Undefined = answer 404.
 */
export function requireTableData(
  request: Pick<PlatformActionRequest, 'actor'>,
  ctx: AccessContext,
  tableId: number,
  op: TableDataOp,
  options: { allowMaskedValues?: boolean } = {},
): Promise<TableDataAccess | undefined> {
  return tableDataAccess(ctx, request.actor, tableId, op, options);
}

// ─── Drive (scope = 'tables') ─────────────────────────────

/**
 * Does `scope` read `fieldId`? For per-field projections outside a record row:
 * activity changes, notification templates, file attachments. Pass `readScope`.
 */
export function scopeReads(scope: TableAccessScope, fieldId: number): boolean {
  return scope.kind === 'full' || scope.readableFieldIds.includes(fieldId);
}

/**
 * May `actor` download this Base file as a restricted reader? Only when it is
 * attached, in an attachment field they can read, to a live record inside
 * their row scope (D15) — the same `requireTableData` gate the record itself
 * passes, kernel `record.values` ceiling included.
 */
export async function canReadTablesFile(
  ctx: AccessContext,
  actor: ActorContext,
  file: { id: number; base_id: number | null },
): Promise<boolean> {
  if (!file.base_id) return false;
  for (const attachment of await ctx.db.tables.listFileAttachments(file.id)) {
    if (attachment.deleted) continue;
    const data = await tableDataAccess(ctx, actor, attachment.table_id, 'read', {});
    if (!data || data.base.id !== file.base_id || !scopeReads(data.readScope, attachment.field_id)) continue;
    if (await ctx.db.tables.getRecord(attachment.table_id, attachment.record_id, data.scope)) return true;
  }
  return false;
}

/**
 * May this access put files into the Base's cabinet? Built-in editors and up;
 * a custom role only when it can create or edit some attachment field.
 */
export async function canUploadTablesFiles(
  ctx: AccessContext,
  access: ResolvedBaseAccess,
  userId: string,
): Promise<boolean> {
  if (access.level === 'none') return false;
  if (access.level !== 'custom') return tableRoleAtLeast(access.level, 'editor');
  const lens = await customAccessLens(ctx, access, userId);
  if (!lens) return false;
  return lens.facts.fields.some(
    (field) =>
      field.type === 'attachment' && (lens.scopeFor(field.tableId)?.editableFieldIds.includes(field.id) ?? false),
  );
}

// ─── Recipients ───────────────────────────────────────────

/** How a notification recipient can read a record — decides the template's fields and the link. */
export type RecipientReadAccess =
  | { via: 'base'; scope: TableAccessScope }
  | { via: 'app'; appId: number; roleKey: string; scope: TableAccessScope };

async function recipientReadViaBase(
  ctx: AccessContext,
  userId: string,
  record: RecordRef,
): Promise<RecipientReadAccess | null> {
  const actor = humanActor({ id: userId });
  if (!(await getPlatformRuntime().authorize(actor, 'tables.data.read')).allowed) return null;
  const data = await tableDataAccess(ctx, actor, record.table_id, 'read', { allowMaskedValues: true });
  if (!data) return null;
  // The row itself must be inside the scope (a custom role's row predicate).
  const visible = await ctx.db.tables.getRecord(record.table_id, record.id, data.scope);
  return visible ? { via: 'base', scope: data.readScope } : null;
}

/**
 * A recipient who reaches the record through an app audience (Phase 1): the
 * kernel ceiling an app viewer reads under (`appDataCeiling`, plus
 * `tables.apps.use`), then a live app on the record's Base where their role
 * covers the table and some card on a page they see holds the row
 * (`appReachForRecord`). The scope renders the role's readable fields ∩ what
 * that card shows; a masked `record.values` policy renders none.
 */
async function recipientReadViaApp(
  ctx: AccessContext,
  userId: string,
  record: RecordRef,
): Promise<RecipientReadAccess | null> {
  const actor = humanActor({ id: userId });
  if (!(await getPlatformRuntime().authorize(actor, 'tables.apps.use')).allowed) return null;
  const table = await ctx.db.tables.getTable(record.table_id);
  const base = table ? await ctx.db.tables.getBase(table.base_id) : undefined;
  if (!base) return null;
  const ceiling = await appDataCeiling(ctx, actor, base, 'read');
  if (!ceiling || ceiling.read === 'none') return null;
  const reach = await appReachForRecord(ctx, userId, record);
  if (!reach) return null;
  return {
    via: 'app',
    appId: reach.appId,
    roleKey: reach.roleKey,
    scope: ceiling.read === 'full' ? reach.scope : valuelessScope(userId, record.table_id),
  };
}

// ─── App viewers (Phase 1) ────────────────────────────────

/** What the kernel lets an app viewer do with record data: the `record.values` read level and write. */
export interface AppDataCeiling {
  read: 'full' | 'masked' | 'none';
  write: boolean;
}

/**
 * The kernel ceiling on an app viewer's record data (apps spec §3 "外层上限"):
 * the matching Tables data capability (`tables.data.read` for reads,
 * `.create / .update / .delete` for writes, `.comment` for comments), the
 * `record` entity scope over the Base — an app audience counts as
 * collaborating, like a member — and the `record.values` field policy.
 * Undefined = no access at all. The app's own rules decide everything below it.
 */
export async function appDataCeiling(
  ctx: AccessContext,
  actor: ActorContext,
  base: TableBaseRow,
  op: TableDataOp | 'comment',
): Promise<AppDataCeiling | undefined> {
  return appDataCeilings(ctx, actor, base)(op);
}

/**
 * `appDataCeiling` for every op one request asks about: the actor's capability
 * snapshot and the `record` entity policy load once, each op resolves against
 * them (and is answered once). Hold the resolver for one request only — the
 * gateway session does — so a revocation applies to the next request.
 */
export function appDataCeilings(
  ctx: AccessContext,
  actor: ActorContext,
  base: TableBaseRow,
): (op: TableDataOp | 'comment') => Promise<AppDataCeiling | undefined> {
  let decide: ReturnType<ReturnType<typeof getPlatformRuntime>['capabilities']> | undefined;
  let policy: Promise<EntityPolicy> | undefined;
  const answers = new Map<TableDataOp | 'comment', Promise<AppDataCeiling | undefined>>();
  const resolve = async (op: TableDataOp | 'comment'): Promise<AppDataCeiling | undefined> => {
    decide ??= getPlatformRuntime().capabilities(actor);
    if (!(await decide)(`tables.data.${op}`).allowed) return undefined;
    policy ??= entityPolicy(ctx, actor, 'record');
    const loaded = await policy;
    if (!canAccessRecord(actor, { ownerId: base.owner_id, collaboratorIds: [effectiveUserId(actor)] }, loaded)) {
      return undefined;
    }
    const values = fieldPolicyFor(loaded, 'values');
    return { read: values.read, write: values.write };
  };
  return (op) => {
    let found = answers.get(op);
    if (!found) {
      found = resolve(op);
      answers.set(op, found);
    }
    return found;
  };
}

/** A scope that sees rows but no values — what a masked `record.values` reader gets. */
export function valuelessReadScope(userId: string, tableId: number): TableDataScope {
  return valuelessScope(userId, tableId);
}

/**
 * Can `userId` read `record`, and through what? Null = skip this recipient
 * (automation notify, @mentions). The scope says which fields a template may
 * render for them — for a custom role, its compiled readable fields — and
 * everything else renders as "—".
 */
export async function canRecipientRead(
  ctx: AccessContext,
  userId: string,
  record: RecordRef,
): Promise<RecipientReadAccess | null> {
  return (await recipientReadViaBase(ctx, userId, record)) ?? (await recipientReadViaApp(ctx, userId, record));
}
