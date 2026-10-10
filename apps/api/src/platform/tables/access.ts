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
 * Slice A fills the two marked hooks (`loadCustomRole`, `customTableScope`) and
 * the group branch; until then a custom grant resolves to `none` (spec D13).
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
  type UserRow,
} from '@greenhouse/db';
import {
  decideTableBaseAccess,
  fullTableAccess,
  tableRoleAtLeast,
  type TableAccessRules,
  type TableAccessScope,
  type TableBaseAccessDecision,
  type TableBaseAccessView,
  type TableDataScope,
} from '@greenhouse/types/table-access';
import type { TableBaseRole } from '@greenhouse/types/tables';
import { humanActor } from '../actor.js';
import { tablesManifest } from '../manifests/tables.js';
import { getPlatformRuntime, type PlatformHandlerContext } from '../runtime.js';

type AccessContext = Pick<PlatformHandlerContext, 'db'>;
type AccessUser = Pick<UserRow, 'id' | 'role' | 'status'>;
type RecordRef = Pick<TableRecordRow, 'id' | 'table_id'>;

/** A Base level plus, for `custom`, the loaded role. */
export interface ResolvedBaseAccess extends TableBaseAccessDecision {
  customRole?: { id: number; name: string; rules: TableAccessRules };
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

export async function baseForView(db: DatabaseProvider, viewId: number): Promise<TableBaseRow | undefined> {
  const view = await db.tables.getView(viewId);
  return view ? baseForTable(db, view.table_id) : undefined;
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

// ─── The effective Base level ─────────────────────────────

/**
 * Slice A: load the custom role `roleId`, refusing one that belongs to another
 * Base. Undefined = dangling or not yet supported → no access, never viewer (D13).
 */
async function loadCustomRole(
  _ctx: AccessContext,
  _base: TableBaseRow,
  _roleId: number,
): Promise<ResolvedBaseAccess['customRole']> {
  return undefined;
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
  // Super and the owner never depend on a member row.
  const member =
    user.role === 'super' || base.owner_id === user.id
      ? undefined
      : await ctx.db.tables.getBaseMember(base.id, user.id);
  return completeDecision(ctx, base, decideTableBaseAccess({ user, base, member }));
}

/** `resolveBaseAccess` for many people on one Base, with one member-row query. */
export async function resolveBaseAccessForUsers(
  ctx: AccessContext,
  users: readonly AccessUser[],
  base: TableBaseRow,
): Promise<Map<string, ResolvedBaseAccess>> {
  const members = new Map<string, TableBaseMemberRow>(
    (await ctx.db.tables.listBaseMembers(base.id)).map((member) => [member.user_id, member]),
  );
  const out = new Map<string, ResolvedBaseAccess>();
  for (const user of users) {
    out.set(
      user.id,
      await completeDecision(ctx, base, decideTableBaseAccess({ user, base, member: members.get(user.id) })),
    );
  }
  return out;
}

/** The built-in role a level shows as (`getBase.role`). A custom role reads as viewer; its rules travel in `access`. */
export function displayRole(access: ResolvedBaseAccess): TableBaseRole | undefined {
  if (access.level === 'none') return undefined;
  return access.level === 'custom' ? 'viewer' : access.level;
}

/** The wire form of an access (`getBase.access`): rules only for custom, so the client can hide what the server refuses. */
export function accessView(access: ResolvedBaseAccess): TableBaseAccessView {
  return access.customRole
    ? {
        level: access.level,
        customRole: { id: access.customRole.id, name: access.customRole.name },
        rules: access.customRole.rules,
      }
    : { level: access.level };
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
 * Slice A: compile a custom role's rule for `tableId` into the scope `op`
 * needs — undefined when the role has no rule for the table or the rule does
 * not allow `op` (read rule only, `create` / `delete` off). Unreachable until
 * A, because `loadCustomRole` resolves every custom grant to `none`.
 */
function customTableScope(
  _access: ResolvedBaseAccess,
  _tableId: number,
  _op: TableDataOp,
  _userId: string,
): TableDataScope | undefined {
  return undefined;
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
    const compiled = customTableScope(gate.access, tableId, op, userId);
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
 * Phase 1 extension point: a recipient who reaches the record only through an
 * app audience returns `{ via: 'app', appId, roleKey, scope }`. Phase 0 has no apps.
 */
async function recipientReadViaApp(
  _ctx: AccessContext,
  _userId: string,
  _record: RecordRef,
): Promise<RecipientReadAccess | null> {
  return null;
}

/**
 * Can `userId` read `record`, and through what? Null = skip this recipient
 * (automation notify, @mentions). The scope says which fields a template may
 * render for them; everything else renders as "—".
 */
export async function canRecipientRead(
  ctx: AccessContext,
  userId: string,
  record: RecordRef,
): Promise<RecipientReadAccess | null> {
  return (await recipientReadViaBase(ctx, userId, record)) ?? (await recipientReadViaApp(ctx, userId, record));
}
