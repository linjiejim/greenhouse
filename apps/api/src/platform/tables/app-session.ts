/**
 * Opening an app for one gateway request (docs/specs/20261011-tables-apps.md
 * §3) — who the caller is to the app, through which spec and role, and the
 * scope every data step starts from.
 *
 * - **Managers** (Base owner / builder with the kernel's `tables.apps.manage`,
 *   D2 — `requireAppManager`) always open it: full access (`role` undefined,
 *   the `__manager__` view) or, with `previewRole`, as one of its roles. They
 *   work on the published version, or on the draft with `draft: true` (and
 *   before the first publish). Writes run as the manager.
 * - **Viewers** — everyone else, a Base builder without the manage capability
 *   included — open only a live published app on a live Base, as their one
 *   role (D3, `app-audience.ts`); no role → 404. `previewRole` / `draft` are
 *   ignored for them.
 * - **Data steps** ask `tableAccess(op)`: the kernel ceiling first
 *   (`appDataCeiling` — the Tables data capability for the op, the `record`
 *   entity scope, the `record.values` policy; missing → 403 `not_allowed`),
 *   then the role's compiled scope on the table (no rule → the card is
 *   `no_access`). A manager's full access is the same shape: every live field
 *   readable, every stored one editable, create and delete allowed.
 * - **D6**: `pageIssues` re-runs the spec's schema checks for one page; a card
 *   with an issue is unavailable, an action with one cannot run, a page filter
 *   with one is dropped.
 * - **One read per request**: the Base row, the access facts (the spec schema
 *   is built on them), each table's fields and the kernel ceilings are read
 *   once per session and shared by every step — never kept across requests
 *   (a revocation applies to the next one).
 */

import { effectiveUserId, type ActorContext } from '@greenhouse/platform-kernel';
import type { TableAppRow, TableBaseRow, TableFieldRow } from '@greenhouse/db';
import {
  findRole,
  pagesForRole,
  type AppCard,
  type AppIssue,
  type AppPage,
  type AppRole,
  type AppSpec,
} from '@greenhouse/types/apps';
import type { TableAccessSchemaFacts, TableDataScope } from '@greenhouse/types/table-access';
import { trimFilterControlsForReader } from '@greenhouse/types/table-cards';
import { isComputedFieldType, type TableFilterControl } from '@greenhouse/types/tables';
import {
  appDataCeilings,
  capabilitySnapshot,
  requireAppManager,
  type AppDataCeiling,
  type TableDataOp,
} from './access.js';
import { compileAppRole, liveAppOf, viewerRoleIn, type CompiledAppRole } from './app-audience.js';
import { loadAppSpecSchema, parseStoredAppSpec, revalidateSpec, type AppSpecSchema } from './app-spec.js';
import { fail, type Handler, type HandlerRequest } from './handlers/shared.js';
import type { PlatformActionResult } from '@greenhouse/platform-kernel';

type Context = Parameters<Handler>[1];

export interface AppSession {
  app: TableAppRow;
  base: TableBaseRow;
  spec: AppSpec;
  /** The published version in play; 0 for a manager's draft. */
  version: number;
  draft: boolean;
  actor: ActorContext;
  userId: string;
  /** The caller manages the app (Base owner / builder + `tables.apps.manage`): full access unless previewing a role. */
  manager: boolean;
  /** Owner level on the Base (owner / super). */
  owner: boolean;
  /** The role in play — the viewer's, or a manager's preview. Undefined = a manager's full access. */
  role?: AppRole;
  /** Pages the caller may open, in spec order. */
  pages: AppPage[];
  facts(): Promise<TableAccessSchemaFacts>;
  /** The spec schema — built on the same `facts()` load, its field reads shared for the request. */
  schema(): Promise<AppSpecSchema>;
  /** One table's active fields in display order (read once per request, shared with the checks). */
  fields(tableId: number): Promise<TableFieldRow[]>;
  /** The kernel ceiling for one op (`appDataCeiling`), resolved once per request. */
  ceiling(op: TableDataOp | 'comment'): Promise<AppDataCeiling | undefined>;
  /** D6 issues of one page against today's schema (cached per request). */
  pageIssues(pageId: string): Promise<AppIssue[]>;
}

export type SessionResult = { ok: true; session: AppSession } | { ok: false; result: PlatformActionResult };

const NOT_FOUND = (): PlatformActionResult => fail('NOT_FOUND', 'App not found');

function readFlag(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true || payload[key] === 'true' || payload[key] === '1';
}

function memo<T>(load: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= load());
}

/** Open the app `appId` for the caller (see the module comment). */
export async function openAppSession(
  context: Context,
  request: HandlerRequest,
  payload: Record<string, unknown>,
  appId: number | undefined,
): Promise<SessionResult> {
  if (!appId) return { ok: false, result: fail('INVALID_INPUT', 'appId is required') };
  const app = await context.db.tables.getApp(appId);
  if (!app || app.archived_at || app.status === 'archived') return { ok: false, result: NOT_FOUND() };
  const base = await context.db.tables.getBase(app.base_id);
  if (!base || base.archived_at) return { ok: false, result: NOT_FOUND() };
  const actor = request.actor;
  const userId = effectiveUserId(actor);
  // One capability snapshot per request: the manage check and the data ceilings share it.
  const capabilities = capabilitySnapshot(actor);
  const grant = await requireAppManager(context, actor, base, capabilities);

  let spec: AppSpec | undefined;
  let version = 0;
  let draft = false;
  let role: AppRole | undefined;
  if (grant) {
    draft = readFlag(payload, 'draft') || !app.published_version;
    if (draft) {
      spec = parseStoredAppSpec(app.draft_spec);
    } else {
      const row = await context.db.tables.getAppVersion(app.id, app.published_version!);
      spec = row ? parseStoredAppSpec(row.spec) : undefined;
      version = row?.version ?? 0;
    }
    if (!spec) return { ok: false, result: fail('INVALID_INPUT', 'The stored spec is not a valid app spec') };
    const preview = typeof payload.previewRole === 'string' && payload.previewRole ? payload.previewRole : undefined;
    if (preview) {
      role = findRole(spec, preview);
      if (!role) return { ok: false, result: fail('INVALID_INPUT', `Unknown role "${preview}"`) };
    }
  } else {
    const live = await liveAppOf(context.db, app, base);
    if (!live) return { ok: false, result: NOT_FOUND() };
    role = await viewerRoleIn(context.db, live, userId);
    if (!role) return { ok: false, result: NOT_FOUND() };
    spec = live.spec;
    version = live.version;
  }

  const facts = memo(() => context.db.tables.loadAccessFacts(base.id));
  const schema = memo(() => loadAppSpecSchema(context.db, base.id, facts()));
  const issues = new Map<string, Promise<AppIssue[]>>();
  const resolvedSpec = spec;
  const session: AppSession = {
    app,
    base,
    spec: resolvedSpec,
    version,
    draft,
    actor,
    userId,
    manager: Boolean(grant),
    owner: grant?.access.level === 'owner',
    ...(role ? { role } : {}),
    pages: role ? pagesForRole(resolvedSpec, role) : resolvedSpec.pages,
    facts,
    schema,
    fields: (tableId) => schema().then((loaded) => loaded.source.fields(tableId)),
    ceiling: appDataCeilings(context, actor, base, capabilities),
    pageIssues: (pageId) => {
      let found = issues.get(pageId);
      if (!found) {
        const page = resolvedSpec.pages.find((entry) => entry.id === pageId);
        found = page
          ? schema().then((loaded) => revalidateSpec({ ...resolvedSpec, pages: [page] }, loaded))
          : Promise.resolve([]);
        issues.set(pageId, found);
      }
      return found;
    },
  };
  return { ok: true, session };
}

// ─── Cards ────────────────────────────────────────────────

export interface LocatedCard {
  page: AppPage;
  card: AppCard;
  /** Card-level D6 issue: the card is unavailable. */
  unavailable?: string;
  /** Action / button ids with an issue on this card. */
  brokenActions: ReadonlySet<string>;
  /** Page filter ids with an issue. */
  brokenFilters: ReadonlySet<string>;
}

/** A card on a page the caller may open, with its D6 state. Undefined = 404. */
export async function locateSessionCard(
  session: AppSession,
  pageId: unknown,
  cardId: unknown,
): Promise<LocatedCard | undefined> {
  if (typeof pageId !== 'string' || typeof cardId !== 'string') return undefined;
  const page = session.pages.find((entry) => entry.id === pageId);
  const card = page?.cards.find((entry) => entry.id === cardId);
  if (!page || !card) return undefined;
  const issues = await session.pageIssues(page.id);
  const cardIssue = issues.find((issue) => issue.cardId === card.id && !issue.actionId && !issue.filterId);
  return {
    page,
    card,
    ...(cardIssue ? { unavailable: cardIssue.message } : {}),
    brokenActions: new Set(
      issues.flatMap((issue) => (issue.cardId === card.id && issue.actionId ? [issue.actionId] : [])),
    ),
    brokenFilters: new Set(issues.flatMap((issue) => (issue.filterId ? [issue.filterId] : []))),
  };
}

/** Does the role in play (or a manager's full access) pass a spec `roles` list? */
export function sessionRoleAllows(session: AppSession, roles: readonly string[] | undefined): boolean {
  if (!session.role) return true;
  return !roles || roles.includes(session.role.key);
}

// ─── Data scopes ──────────────────────────────────────────

const compiledRoles = new WeakMap<AppSession, Promise<CompiledAppRole | undefined>>();

function compiledRole(session: AppSession): Promise<CompiledAppRole | undefined> {
  let found = compiledRoles.get(session);
  if (!found) {
    const role = session.role;
    found = role ? session.facts().then((facts) => compileAppRole(role, facts)) : Promise.resolve(undefined);
    compiledRoles.set(session, found);
  }
  return found;
}

/** A manager's full access to one table in the compiled shape: every live field read, every stored one written. */
function fullScope(session: AppSession, facts: TableAccessSchemaFacts, tableId: number): TableDataScope {
  const fields = facts.fields.filter((field) => field.tableId === tableId);
  const targets = [
    ...new Set(fields.flatMap((field) => (field.relationTargetTableId ? [field.relationTargetTableId] : []))),
  ];
  return {
    kind: 'scoped',
    userId: session.userId,
    tableId,
    rows: [],
    editRows: [],
    readableFieldIds: fields.map((field) => field.id),
    editableFieldIds: fields.filter((field) => !isComputedFieldType(field.type)).map((field) => field.id),
    canCreate: true,
    canDelete: true,
    relationTargets: targets.map((target) => ({ tableId: target, rows: [] })),
  };
}

export type TableAccessOutcome =
  | { ok: true; scope: TableDataScope; ceiling: AppDataCeiling; editable: boolean }
  /** The kernel refuses the op (capability / entity scope): 403 `not_allowed`. */
  | { ok: false; reason: 'not_allowed' }
  /** The role has no rule for the table, or it is not a live table of the Base. */
  | { ok: false; reason: 'no_access' };

/**
 * The caller's scope on one table of the app's Base for `op`. `editable` says
 * whether the role's rule is `access: 'edit'` (a manager: always).
 */
export async function sessionTableAccess(
  context: Context,
  session: AppSession,
  tableId: number,
  op: TableDataOp | 'comment',
): Promise<TableAccessOutcome> {
  const ceiling = await session.ceiling(op);
  if (!ceiling) return { ok: false, reason: 'not_allowed' };
  const facts = await session.facts();
  if (!facts.tables.some((table) => table.id === tableId)) return { ok: false, reason: 'no_access' };
  const compiled = await compiledRole(session);
  if (!compiled) return { ok: true, scope: fullScope(session, facts, tableId), ceiling, editable: true };
  const scope = compiled.scopeFor(tableId, session.userId);
  if (!scope) return { ok: false, reason: 'no_access' };
  const rule = compiled.rules.tables.find((entry) => entry.tableId === tableId);
  return { ok: true, scope, ceiling, editable: rule?.access === 'edit' };
}

/** Readable field ids per table for the role in play (null = every field: a manager). Undefined = table unreadable. */
export async function sessionReadable(
  session: AppSession,
): Promise<(tableId: number) => ReadonlySet<number> | null | undefined> {
  const compiled = await compiledRole(session);
  const facts = await session.facts();
  const live = new Set(facts.tables.map((table) => table.id));
  if (!compiled) return (tableId) => (live.has(tableId) ? null : undefined);
  const cache = new Map<number, ReadonlySet<number> | undefined>();
  return (tableId) => {
    if (!cache.has(tableId)) {
      const scope = compiled.scopeFor(tableId, session.userId);
      cache.set(tableId, scope ? new Set(scope.readableFieldIds) : undefined);
    }
    return cache.get(tableId);
  };
}

/** Editable field ids per table for the role in play (null = a manager: every stored field). Undefined = none. */
export async function sessionEditable(
  session: AppSession,
): Promise<(tableId: number) => ReadonlySet<number> | null | undefined> {
  const compiled = await compiledRole(session);
  const facts = await session.facts();
  const live = new Set(facts.tables.map((table) => table.id));
  if (!compiled) return (tableId) => (live.has(tableId) ? null : undefined);
  const cache = new Map<number, ReadonlySet<number> | undefined>();
  return (tableId) => {
    if (!cache.has(tableId)) {
      const scope = compiled.scopeFor(tableId, session.userId);
      cache.set(tableId, scope && scope.editableFieldIds.length > 0 ? new Set(scope.editableFieldIds) : undefined);
    }
    return cache.get(tableId);
  };
}

/**
 * A page's filter controls as the role in play may use them: broken ones
 * (D6) dropped, targets on fields it cannot read removed (a control left
 * empty disappears) — the Phase 0 reader trim. Values sent for a dropped
 * control are ignored.
 */
export async function sessionPageControls(
  session: AppSession,
  page: AppPage,
  brokenFilters: ReadonlySet<string> = new Set(),
): Promise<TableFilterControl[]> {
  const readable = await sessionReadable(session);
  const controls = (page.filters ?? []).filter((control) => !brokenFilters.has(control.id));
  return trimFilterControlsForReader(controls, readable);
}
