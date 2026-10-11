/**
 * What publishing would change (spec §6 publish dialog): the draft against
 * the live version — pages, cards and roles added / removed / changed — and,
 * because publishing *is* granting access (D2), every permission that moves,
 * before → after: a role's pages, comments, and per table its access level,
 * the rows it reads and may change, create / delete and each field.
 *
 * Pure: the dialog renders the result; the tests pin it. Comparison is by
 * value with keys sorted, so the server's normalized copy and the builder's
 * copy of an unchanged card compare equal.
 */

import type { AppAudienceEntryView, AppCard, AppPage, AppRole, AppSpec } from '@greenhouse/types/apps';
import {
  fieldAccessFor,
  type TableAccessRule,
  type TableFieldAccess,
  type TableRowScope,
} from '@greenhouse/types/table-access';

/** JSON with object keys sorted — equal values give equal text whatever the key order. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
  });
}

function same(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

// ─── Structure ────────────────────────────────────────────

export interface PageChange {
  page: AppPage;
  /** The live title, when it changed. */
  renamedFrom?: string;
  /** Icon or filters changed. */
  settingsChanged: boolean;
  cardsAdded: AppCard[];
  cardsRemoved: AppCard[];
  cardsChanged: AppCard[];
}

export type AccessLevel = 'none' | 'read' | 'edit';
export type RowsKind = 'all' | 'related' | 'where';

interface RoleRef {
  roleKey: string;
  roleName: string;
}

export type PermissionChange =
  | ({ kind: 'roleAdded' } & RoleRef)
  | ({ kind: 'roleRemoved' } & RoleRef)
  /** `before` is absent for a new role (it had no pages to lose). */
  | ({ kind: 'pages'; before?: 'all' | string[]; after: 'all' | string[] } & RoleRef)
  | ({ kind: 'comment'; before: boolean; after: boolean } & RoleRef)
  | ({
      kind: 'table';
      tableId: number;
      before: AccessLevel;
      after: AccessLevel;
      /** When the table opens: how many of its fields the role sees / edits. */
      visibleAfter?: number;
      editableAfter?: number;
    } & RoleRef)
  /** `changed`: same kind of scope, different people fields or conditions. */
  | ({ kind: 'rows' | 'editRows'; tableId: number; before: RowsKind; after: RowsKind; changed: boolean } & RoleRef)
  | ({ kind: 'create' | 'delete'; tableId: number; before: boolean; after: boolean } & RoleRef)
  | ({ kind: 'field'; tableId: number; fieldId: number; before: TableFieldAccess; after: TableFieldAccess } & RoleRef);

export interface SpecDiff {
  /** Nothing is live yet: everything is new. */
  first: boolean;
  pagesAdded: AppPage[];
  pagesRemoved: AppPage[];
  pagesChanged: PageChange[];
  rolesAdded: AppRole[];
  rolesRemoved: AppRole[];
  rolesChanged: AppRole[];
  /** The home page or the navigation layout. */
  appSettingsChanged: boolean;
  permissions: PermissionChange[];
}

export function isEmptyDiff(diff: SpecDiff): boolean {
  return (
    !diff.first &&
    diff.pagesAdded.length === 0 &&
    diff.pagesRemoved.length === 0 &&
    diff.pagesChanged.length === 0 &&
    diff.rolesAdded.length === 0 &&
    diff.rolesRemoved.length === 0 &&
    diff.rolesChanged.length === 0 &&
    !diff.appSettingsChanged
  );
}

function pageChange(before: AppPage, after: AppPage): PageChange | null {
  const beforeCards = new Map(before.cards.map((card) => [card.id, card]));
  const afterIds = new Set(after.cards.map((card) => card.id));
  const change: PageChange = {
    page: after,
    settingsChanged: before.icon !== after.icon || !same(before.filters ?? [], after.filters ?? []),
    cardsAdded: after.cards.filter((card) => !beforeCards.has(card.id)),
    cardsRemoved: before.cards.filter((card) => !afterIds.has(card.id)),
    cardsChanged: after.cards.filter((card) => {
      const previous = beforeCards.get(card.id);
      return previous !== undefined && !same(previous, card);
    }),
  };
  if (before.title !== after.title) change.renamedFrom = before.title;
  const changed =
    change.renamedFrom !== undefined ||
    change.settingsChanged ||
    change.cardsAdded.length + change.cardsRemoved.length + change.cardsChanged.length > 0;
  return changed ? change : null;
}

// ─── Permissions ──────────────────────────────────────────

function level(rule: TableAccessRule | undefined): AccessLevel {
  return rule ? rule.access : 'none';
}

function rowsKind(scope: TableRowScope | undefined): RowsKind {
  return scope?.type === 'related' || scope?.type === 'where' ? scope.type : 'all';
}

function canCreate(rule: TableAccessRule | undefined): boolean {
  return rule?.access === 'edit' && rule.create !== false;
}

function canDelete(rule: TableAccessRule | undefined): boolean {
  return rule?.access === 'edit' && rule.delete === true;
}

/** The fields a role's rule can say something about: the table's fields, plus any the rules name. */
export type TableFieldIds = (tableId: number) => readonly number[];

function tableChanges(
  ref: RoleRef,
  tableId: number,
  before: TableAccessRule | undefined,
  after: TableAccessRule | undefined,
  fieldIds: readonly number[],
): PermissionChange[] {
  const out: PermissionChange[] = [];
  const from = level(before);
  const to = level(after);
  if (from !== to) {
    const counts =
      after && to !== 'none'
        ? {
            visibleAfter: fieldIds.filter((id) => fieldAccessFor(after, id) !== 'hidden').length,
            editableAfter: fieldIds.filter((id) => fieldAccessFor(after, id) === 'edit').length,
          }
        : {};
    out.push({ ...ref, kind: 'table', tableId, before: from, after: to, ...counts });
  }
  // Opening or closing a whole table says it all; the details only matter while it stays open.
  if (!before || !after) return out;
  const scopeChange = (
    kind: 'rows' | 'editRows',
    left: TableRowScope | undefined,
    right: TableRowScope | undefined,
  ) => {
    const a = rowsKind(left);
    const b = rowsKind(right);
    const changed = a === b && a !== 'all' && !same(left, right);
    if (a !== b || changed) out.push({ ...ref, kind, tableId, before: a, after: b, changed });
  };
  scopeChange('rows', before.rows, after.rows);
  if (before.access === 'edit' && after.access === 'edit') {
    scopeChange('editRows', before.editRows ?? before.rows, after.editRows ?? after.rows);
  }
  if (canCreate(before) !== canCreate(after)) {
    out.push({ ...ref, kind: 'create', tableId, before: canCreate(before), after: canCreate(after) });
  }
  if (canDelete(before) !== canDelete(after)) {
    out.push({ ...ref, kind: 'delete', tableId, before: canDelete(before), after: canDelete(after) });
  }
  const ids = new Set([...fieldIds, ...before.fields.map((f) => f.fieldId), ...after.fields.map((f) => f.fieldId)]);
  for (const fieldId of [...ids].sort((a, b) => a - b)) {
    const was = fieldAccessFor(before, fieldId);
    const now = fieldAccessFor(after, fieldId);
    if (was !== now) out.push({ ...ref, kind: 'field', tableId, fieldId, before: was, after: now });
  }
  return out;
}

const NO_ACCESS_ROLE: Omit<AppRole, 'key' | 'name'> = { pages: [], tables: [] };

function roleChanges(before: AppRole | undefined, after: AppRole, fieldIds: TableFieldIds): PermissionChange[] {
  const ref = { roleKey: after.key, roleName: after.name };
  const out: PermissionChange[] = before ? [] : [{ ...ref, kind: 'roleAdded' }];
  const was = before ?? { ...NO_ACCESS_ROLE, key: after.key, name: after.name };
  if (!before) out.push({ ...ref, kind: 'pages', after: after.pages });
  else if (!same(was.pages, after.pages)) out.push({ ...ref, kind: 'pages', before: was.pages, after: after.pages });
  if (Boolean(was.canComment) !== Boolean(after.canComment)) {
    out.push({ ...ref, kind: 'comment', before: Boolean(was.canComment), after: Boolean(after.canComment) });
  }
  const tableIds = [...new Set([...was.tables, ...after.tables].map((rule) => rule.tableId))].sort((a, b) => a - b);
  for (const tableId of tableIds) {
    const left = was.tables.find((rule) => rule.tableId === tableId);
    const right = after.tables.find((rule) => rule.tableId === tableId);
    out.push(...tableChanges(ref, tableId, left, right, fieldIds(tableId)));
  }
  return out;
}

/**
 * The draft (`after`) against the live version (`before`; null before the
 * first publish). `fieldIds` names the fields of a table, so a rule that opens
 * every field by default reports them.
 */
export function diffSpecs(before: AppSpec | null, after: AppSpec, fieldIds: TableFieldIds): SpecDiff {
  const live = before ?? { version: 1, pages: [], roles: [] };
  const livePages = new Map(live.pages.map((page) => [page.id, page]));
  const liveRoles = new Map(live.roles.map((role) => [role.key, role]));
  const draftPages = new Set(after.pages.map((page) => page.id));
  const draftRoles = new Set(after.roles.map((role) => role.key));

  const permissions: PermissionChange[] = [];
  for (const role of after.roles) permissions.push(...roleChanges(liveRoles.get(role.key), role, fieldIds));
  for (const role of live.roles) {
    if (!draftRoles.has(role.key)) permissions.push({ kind: 'roleRemoved', roleKey: role.key, roleName: role.name });
  }

  return {
    first: before === null,
    pagesAdded: after.pages.filter((page) => !livePages.has(page.id)),
    pagesRemoved: live.pages.filter((page) => !draftPages.has(page.id)),
    pagesChanged: after.pages.flatMap((page) => {
      const previous = livePages.get(page.id);
      const change = previous ? pageChange(previous, page) : null;
      return change ? [change] : [];
    }),
    rolesAdded: after.roles.filter((role) => !liveRoles.has(role.key)),
    rolesRemoved: live.roles.filter((role) => !draftRoles.has(role.key)),
    rolesChanged: after.roles.filter((role) => {
      const previous = liveRoles.get(role.key);
      return previous !== undefined && !same(previous, role);
    }),
    appSettingsChanged: before !== null && (before.home !== after.home || !same(before.nav ?? null, after.nav ?? null)),
    permissions,
  };
}

// ─── Audiences ────────────────────────────────────────────

export interface AudienceImpact {
  entry: AppAudienceEntryView;
  /** Its role is not in the version being published: the entry will grant nothing (D4). */
  losesAccess: boolean;
  /** Its role is not live today but is in this version: publishing opens the app to it. */
  gainsAccess: boolean;
}

export function audienceImpact(entries: readonly AppAudienceEntryView[], after: AppSpec): AudienceImpact[] {
  const keys = new Set(after.roles.map((role) => role.key));
  return entries.map((entry) => ({
    entry,
    losesAccess: !keys.has(entry.roleKey),
    gainsAccess: Boolean(entry.dangling) && keys.has(entry.roleKey),
  }));
}
