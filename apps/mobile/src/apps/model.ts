/**
 * An app page on the phone — pure (root vitest: ./model.test.ts). The spec is
 * the published one, already trimmed to my role by the server (`AppRuntimeView`);
 * these helpers only read it:
 *
 *  - which page shows first, and the cards in reading order (top to bottom,
 *    left to right — the web's grid flattened to one column);
 *  - which card can show a record a push / inbox row names (`?record=`): a
 *    records-like card with a detail view, on the named page first, reading the
 *    record's table first;
 *  - what a card writes and with which fields (form submit, create, a button's
 *    new record, an action's inputs) — only fields my role may write;
 *  - which actions ask first (a delete always does), and who may move a lane;
 *  - why the gateway refused an action (`details.reason`);
 *  - where an in-app `#/…` link (an `open_url` button) leads on the phone.
 */

import {
  APP_BUILTIN_ACTIONS,
  MOBILE_APP_CARDS,
  type AppActionRefusal,
  type AppButton,
  type AppCard,
  type AppCardKind,
  type AppPage,
  type AppRecordAction,
  type AppRuntimeView,
  type AppSpec,
} from '../shared/apps';
import type { TableFieldValueEntry } from '../shared/tables';
import { isComputed } from '../tables/model/fields';

export type RecordsLikeCard = Extract<AppCard, { kind: 'records' | 'kanban' | 'calendar' | 'gallery' }>;

export function isRecordsLike(card: AppCard): card is RecordsLikeCard {
  return card.kind === 'records' || card.kind === 'kanban' || card.kind === 'calendar' || card.kind === 'gallery';
}

/** Card kinds this build draws; anything else is "open on the web". */
export function isMobileCard(kind: string): kind is AppCardKind {
  return (MOBILE_APP_CARDS as readonly string[]).includes(kind);
}

/** The page to show: the asked one if I may see it, else the spec's home, else the first. */
export function pageFor(spec: AppSpec, pageId: string | null | undefined): AppPage | undefined {
  return (
    (pageId ? spec.pages.find((page) => page.id === pageId) : undefined) ??
    (spec.home ? spec.pages.find((page) => page.id === spec.home) : undefined) ??
    spec.pages[0]
  );
}

/** A page's cards top to bottom, left to right. */
export function cardsInOrder(page: AppPage): AppCard[] {
  return [...page.cards].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
}

/**
 * Cards that can open a record (records-like, with a detail view), best first:
 * the named page's before the others, ones reading `tableId` before the rest.
 */
export function recordCardCandidates(
  spec: AppSpec,
  pageId: string | null | undefined,
  tableId: number | null | undefined,
): Array<{ pageId: string; cardId: string }> {
  const out: Array<{ pageId: string; cardId: string; score: number; order: number }> = [];
  let order = 0;
  for (const page of spec.pages) {
    for (const card of cardsInOrder(page)) {
      order++;
      if (!isRecordsLike(card) || !card.detail) continue;
      // a card on another table cannot hold the record: only a fallback when the table is unknown
      if (tableId && card.source.tableId !== tableId) continue;
      out.push({ pageId: page.id, cardId: card.id, score: page.id === pageId ? 1 : 0, order });
    }
  }
  return out
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ pageId: p, cardId }) => ({ pageId: p, cardId }));
}

/** A card's table (records-like and form cards; aggregates name theirs in the card spec). */
export function cardTableId(card: AppCard): number | null {
  if (isRecordsLike(card)) return card.source.tableId;
  if (card.kind === 'form') return card.tableId;
  if (card.kind === 'kpi' || card.kind === 'chart' || card.kind === 'pivot') return card.card.source?.tableId ?? null;
  return null;
}

/** The role a manager (Base owner / builder) sees the app as: full access, named on the phone, not by the server. */
export const MANAGER_ROLE = '__manager__';

/** The fields of a table as the runtime view describes them (role-readable ones only). */
export function tableFields(view: Pick<AppRuntimeView, 'tables'>, tableId: number | null) {
  return (tableId ? view.tables.find((table) => table.id === tableId)?.fields : undefined) ?? [];
}

/**
 * The inputs of a write my role makes (a form, a create, a button's new record,
 * an action's inputs): the listed fields, in order, that the runtime view says
 * I may write. The gateway refuses any other key — a field I may only read is
 * never offered (the spec's defaults are the server's, never shown).
 */
export function writableFieldIds(
  view: Pick<AppRuntimeView, 'tables'>,
  tableId: number,
  ids: readonly number[],
): number[] {
  const editable = new Set(
    tableFields(view, tableId)
      .filter((field) => field.editable && !isComputed(field))
      .map((field) => field.id),
  );
  return ids.filter((id) => editable.has(id));
}

/** The declared actions a card shows on a record now (`record.actionIds`: allowed for my role, `when` holds). */
export function recordActions(
  actions: readonly AppRecordAction[] | undefined,
  actionIds: readonly string[],
): AppRecordAction[] {
  const allowed = new Set(actionIds);
  return (actions ?? []).filter((action) => allowed.has(action.id));
}

/**
 * Whether a declared action asks before it runs, and how: the builder's words
 * when it wrote some; a delete always asks (in our words, red), as on the web.
 */
export function actionConfirmation(action: AppRecordAction): { message: string | null; destructive: boolean } | null {
  const destructive = action.do.type === 'delete';
  if (!action.confirm && !destructive) return null;
  return { message: action.confirm ?? null, destructive };
}

/** An action that collects fields first (a reason to reject, an amount to approve). */
export function actionInputs(action: AppRecordAction): { fieldIds: number[]; required: number[] } | null {
  if (action.do.type !== 'set_fields' || !action.do.inputFieldIds?.length) return null;
  return { fieldIds: action.do.inputFieldIds, required: action.do.requiredInputFieldIds ?? [] };
}

/** What an app write form is for. */
export type AppWriteMode = 'submit' | 'create' | 'button' | 'action' | 'edit';

/** The fields a write form shows, the hidden defaults it sends, and its gateway action id. */
export function writeTarget(
  card: AppCard,
  mode: AppWriteMode,
  opts: { actionId?: string; buttonId?: string } = {},
): {
  tableId: number;
  fieldIds: number[];
  defaults: TableFieldValueEntry[];
  actionId: string;
  required: number[];
} | null {
  if (mode === 'submit' && card.kind === 'form') {
    return {
      tableId: card.tableId,
      fieldIds: card.fieldIds,
      defaults: card.defaults ?? [],
      actionId: APP_BUILTIN_ACTIONS.submit,
      required: [],
    };
  }
  if (mode === 'create' && card.kind === 'records' && card.create) {
    return {
      tableId: card.source.tableId,
      fieldIds: card.create.fieldIds,
      defaults: card.create.defaults ?? [],
      actionId: APP_BUILTIN_ACTIONS.create,
      required: [],
    };
  }
  if (mode === 'button' && card.kind === 'buttons') {
    const button = card.buttons.find(
      (entry): entry is Extract<AppButton, { type: 'create_record' }> =>
        entry.id === opts.buttonId && entry.type === 'create_record',
    );
    if (!button) return null;
    return {
      tableId: button.tableId,
      fieldIds: button.fieldIds,
      defaults: button.defaults ?? [],
      actionId: APP_BUILTIN_ACTIONS.create,
      required: [],
    };
  }
  if (mode === 'action' && isRecordsLike(card)) {
    const action = [...(card.actions ?? []), ...(card.detail?.actions ?? [])].find(
      (entry) => entry.id === opts.actionId,
    );
    const inputs = action ? actionInputs(action) : null;
    if (!action || !inputs) return null;
    return {
      tableId: card.source.tableId,
      fieldIds: inputs.fieldIds,
      defaults: [],
      actionId: action.id,
      required: inputs.required,
    };
  }
  if (mode === 'edit' && isRecordsLike(card)) {
    return {
      tableId: card.source.tableId,
      fieldIds: [],
      defaults: [],
      actionId: APP_BUILTIN_ACTIONS.edit,
      required: [],
    };
  }
  return null;
}

/**
 * Whether my role may move a kanban card's record to another lane: the card
 * lets my role (`move`, `move.roles`; off unless set) and I may write its lane
 * field — `$move` writes that field, and the gateway refuses it otherwise.
 */
export function canMove(card: AppCard, view: Pick<AppRuntimeView, 'role' | 'tables'>): boolean {
  if (card.kind !== 'kanban' || !card.move || !forRole(card.move.roles, view.role.key)) return false;
  return tableFields(view, card.source.tableId).some((field) => field.id === card.groupFieldId && field.editable);
}

/** Whether my role sees a role-limited thing (`roles` absent = everyone on the page). */
export function forRole(roles: readonly string[] | undefined, roleKey: string): boolean {
  return !roles || roles.includes(roleKey) || roleKey === MANAGER_ROLE;
}

const REFUSALS: readonly AppActionRefusal[] = [
  'precondition',
  'conflict',
  'required_input',
  'not_allowed',
  'not_found',
];

/** Why `/actions` refused (`details.reason`), or null when it did not say. */
export function refusalOf(details: Record<string, unknown> | undefined, status: number): AppActionRefusal | null {
  const reason = details?.reason;
  if (typeof reason === 'string' && (REFUSALS as readonly string[]).includes(reason)) return reason as AppActionRefusal;
  if (status === 404) return 'not_found';
  if (status === 403) return 'not_allowed';
  return null;
}

/** Where an in-app link (the web's `#/…` routes) leads; the phone has a screen for each kind. */
export type InAppLink =
  | { kind: 'app_center' }
  | { kind: 'app'; appId: number; pageId?: string; recordId?: number }
  | { kind: 'tables' }
  | { kind: 'base'; baseId: number }
  | { kind: 'table'; baseId: number; tableId: number; recordId?: number }
  | { kind: 'dashboard'; baseId: number; dashboardId: number }
  | { kind: 'form'; formId: number };

/** A positive integer segment, or null (rejects `01`, `1.5`, `-1`). */
function idOf(raw: string | undefined | null): number | null {
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** `name` from a `a=1&b=2` query, or null. */
function queryValue(query: string, name: string): string | null {
  for (const pair of query.split('&')) {
    const [key, value] = pair.split('=');
    if (key && decodeURIComponent(key) === name) return decodeURIComponent(value ?? '');
  }
  return null;
}

/**
 * Read an in-app link — an `open_url` button may point into the product
 * (`#/apps/7`, `#/tables/1/table/2?record=5`, `#/forms/3`), the web's routes
 * (apps/web/src/lib/app-routes.ts, pages/tables/index.tsx). Null for anything
 * else (another web page, the app builder): the caller opens it on the web.
 */
export function inAppLink(url: string): InAppLink | null {
  const trimmed = url.trim();
  if (!trimmed.startsWith('#/')) return null;
  const at = trimmed.indexOf('?');
  const path = at < 0 ? trimmed.slice(2) : trimmed.slice(2, at);
  const query = at < 0 ? '' : trimmed.slice(at + 1);
  let segments: string[];
  try {
    segments = path
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  const recordId = idOf(queryValue(query, 'record')) ?? undefined;
  const [area, first, second, third] = segments;
  if (area === 'apps') {
    if (segments.length === 1) return { kind: 'app_center' };
    const appId = idOf(first);
    // `#/apps/<id>/edit` is the builder: web only.
    if (appId === null || segments.length > 3 || second === 'edit') return null;
    return { kind: 'app', appId, ...(second ? { pageId: second } : {}), ...(recordId ? { recordId } : {}) };
  }
  if (area === 'tables') {
    if (segments.length === 1) return { kind: 'tables' };
    const baseId = idOf(first);
    if (baseId === null) return null;
    if (segments.length === 2) return { kind: 'base', baseId };
    const id = idOf(third);
    if (segments.length !== 4 || id === null) return null;
    if (second === 'table') return { kind: 'table', baseId, tableId: id, ...(recordId ? { recordId } : {}) };
    if (second === 'dashboard') return { kind: 'dashboard', baseId, dashboardId: id };
    return null;
  }
  if (area === 'forms' && segments.length === 2) {
    const formId = idOf(first);
    return formId === null ? null : { kind: 'form', formId };
  }
  return null;
}
