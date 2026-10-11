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
 *    new record, an action's inputs);
 *  - why the gateway refused an action (`details.reason`).
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

/** The fields of a table as the runtime view describes them (role-readable ones only). */
export function tableFields(view: AppRuntimeView, tableId: number | null) {
  return (tableId ? view.tables.find((table) => table.id === tableId)?.fields : undefined) ?? [];
}

/** The declared actions a card shows on a record now (`record.actionIds`: allowed for my role, `when` holds). */
export function recordActions(
  actions: readonly AppRecordAction[] | undefined,
  actionIds: readonly string[],
): AppRecordAction[] {
  const allowed = new Set(actionIds);
  return (actions ?? []).filter((action) => allowed.has(action.id));
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

/** Whether my role may drag a kanban card's record to another lane (`move.roles`; off unless set). */
export function canMove(card: AppCard, roleKey: string): boolean {
  if (card.kind !== 'kanban' || !card.move) return false;
  return !card.move.roles || card.move.roles.includes(roleKey) || roleKey === '__manager__';
}

/** Whether my role sees a role-limited thing (`roles` absent = everyone on the page). */
export function forRole(roles: readonly string[] | undefined, roleKey: string): boolean {
  return !roles || roles.includes(roleKey) || roleKey === '__manager__';
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
