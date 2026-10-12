/**
 * Pure helpers for app cards (spec 20261011-tables-apps §6): which cards are
 * evaluated by the gateway, which table a card reads, and the adapters that
 * turn what the gateway sends (`AppRuntimeView` field metadata, `AppRecordRow`
 * + `AppRecordRefs`) into the shapes the shared Tables renderers draw
 * (`TableField`, `TableRecord`, users by id). No React, no requests.
 */

import type {
  AppCard,
  AppIssue,
  AppRecordAction,
  AppRecordRefs,
  AppRecordRow,
  AppRuntimeView,
} from '@greenhouse/types/apps';
import type { TableFieldType } from '@greenhouse/types/tables';
import type { TableDefinition, TableField, TableRecord, TableUserOption } from '../../lib/api/tables';
import { monthGridDays } from '../../pages/tables/views/view-query';

export type AppRecordsLikeCard = Extract<AppCard, { kind: 'records' | 'kanban' | 'calendar' | 'gallery' }>;
export type AppAggregateCard = Extract<AppCard, { kind: 'kpi' | 'chart' | 'pivot' }>;
export type AppViewTable = AppRuntimeView['tables'][number];

/** Cards whose content is evaluated by `POST /cards/query` (the others draw from the spec alone). */
export function isQueriedCard(
  card: AppCard,
): card is AppRecordsLikeCard | AppAggregateCard | Extract<AppCard, { kind: 'external' }> {
  return isRecordsLikeCard(card) || isAggregateCard(card) || card.kind === 'external';
}

export function isRecordsLikeCard(card: AppCard): card is AppRecordsLikeCard {
  return card.kind === 'records' || card.kind === 'kanban' || card.kind === 'calendar' || card.kind === 'gallery';
}

export function isAggregateCard(card: AppCard): card is AppAggregateCard {
  return card.kind === 'kpi' || card.kind === 'chart' || card.kind === 'pivot';
}

/** The table a card reads or writes; undefined for text and buttons cards (and a source-less aggregate). */
export function cardTableId(card: AppCard): number | undefined {
  if (isRecordsLikeCard(card)) return card.source.tableId;
  if (card.kind === 'form') return card.tableId;
  if (isAggregateCard(card)) return card.card.source?.tableId;
  return undefined;
}

/** A card's title as the frame shows it: the builder's, else the table's name, else nothing. */
export function cardTitle(card: AppCard, view: AppRuntimeView): string {
  if (card.title?.trim()) return card.title.trim();
  const tableId = cardTableId(card);
  return (tableId !== undefined && view.tables.find((table) => table.id === tableId)?.name) || '';
}

/** Broken by the runtime revalidation (D6): the whole card (an issue naming no action) — every viewer sees it unavailable. */
export function cardIssue(issues: readonly AppIssue[], pageId: string, cardId: string): AppIssue | undefined {
  return issues.find((issue) => issue.pageId === pageId && issue.cardId === cardId && !issue.actionId);
}

/** Actions of a card the revalidation found broken. */
export function brokenActionIds(issues: readonly AppIssue[], pageId: string, cardId: string): Set<string> {
  return new Set(
    issues.flatMap((issue) =>
      issue.pageId === pageId && issue.cardId === cardId && issue.actionId ? [issue.actionId] : [],
    ),
  );
}

// ─── Field metadata → the Tables shapes ───────────────────

export function viewTable(view: AppRuntimeView, tableId: number | undefined): AppViewTable | undefined {
  return tableId === undefined ? undefined : view.tables.find((table) => table.id === tableId);
}

/** A table the role may read, shaped like the Tables definition the view bodies take. */
export function appTableDefinition(view: AppRuntimeView, table: AppViewTable): TableDefinition {
  return {
    id: table.id,
    base_id: view.app.baseId,
    name: table.name,
    description: null,
    position: 0,
    schema_revision: 0,
    created_by: '',
    created_at: '',
    updated_at: '',
    archived_at: null,
  };
}

/**
 * The role-readable fields of a table as `TableField`s (`config` as the stored
 * JSON text the shared renderers parse), in the order the gateway sent them.
 */
export function appTableFields(table: AppViewTable | undefined): TableField[] {
  return (table?.fields ?? []).map((field, position) => ({
    id: field.id,
    table_id: table!.id,
    name: field.name,
    type: field.type as TableFieldType,
    required: field.required === true,
    is_primary: field.isPrimary,
    config: typeof field.config === 'string' ? field.config : JSON.stringify(field.config ?? {}),
    position,
    created_by: '',
    created_at: '',
    updated_at: '',
    archived_at: null,
  }));
}

/** The fields named by `ids`, in that order; ids the role cannot read are skipped. */
export function pickFields(fields: readonly TableField[], ids: readonly number[] | undefined): TableField[] {
  const byId = new Map(fields.map((field) => [field.id, field]));
  return (ids ?? []).flatMap((id) => {
    const field = byId.get(id);
    return field ? [field] : [];
  });
}

/** Fields of this table the role may write (the gateway's `editable`). */
export function editableFieldIds(table: AppViewTable | undefined): Set<number> {
  return new Set((table?.fields ?? []).filter((field) => field.editable).map((field) => field.id));
}

/**
 * The inputs of a write the role makes on this table (a form card, a records
 * card's create, a `create_record` button, an action's inputs): the listed
 * fields, in their order, that the role may write. The gateway refuses any
 * other key, so a field the role may only read is never offered as an input
 * (the spec's defaults are applied by the server, never shown).
 */
export function writableFields(table: AppViewTable | undefined, ids: readonly number[] | undefined): TableField[] {
  const editable = editableFieldIds(table);
  return pickFields(appTableFields(table), ids).filter((field) => editable.has(field.id));
}

// ─── Records and labels ───────────────────────────────────

/** A gateway row as the Tables renderers read a record (computed values arrive merged into `values`). */
export function appRecordToTableRecord(row: AppRecordRow, tableId: number): TableRecord {
  return {
    id: row.id,
    table_id: tableId,
    values: row.values,
    computed_values: {},
    revision: row.revision,
    created_by: row.createdBy ?? '',
    updated_by: row.updatedBy ?? '',
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    deleted_at: null,
  };
}

export const EMPTY_REFS: AppRecordRefs = Object.freeze({ users: {}, records: {}, files: {} });

/** Two label sets as one (a later answer wins for the same key). */
export function mergeRefs(...sets: Array<AppRecordRefs | undefined>): AppRecordRefs {
  const out: AppRecordRefs = { users: {}, records: {}, files: {} };
  for (const refs of sets) {
    if (!refs) continue;
    Object.assign(out.users, refs.users);
    Object.assign(out.records, refs.records);
    Object.assign(out.files, refs.files);
  }
  return out;
}

/** People named in the refs, shaped like the Tables user directory (there is no email for app viewers). */
export function refsUsers(refs: AppRecordRefs): TableUserOption[] {
  return Object.entries(refs.users).map(([id, user]) => ({ id, nickname: user.nickname, email: '' }));
}

export function usersByIdOf(users: readonly TableUserOption[]): ReadonlyMap<string, TableUserOption> {
  return new Map(users.map((user) => [user.id, user]));
}

// ─── Actions ──────────────────────────────────────────────

/**
 * The declared actions offered on one record: the card's (and, in the drawer,
 * the detail's) actions that the gateway says this viewer may run on it now
 * (`actionIds`, `when` checked at read time) and that are not broken.
 */
export function offeredActions(
  actions: readonly AppRecordAction[] | undefined,
  row: Pick<AppRecordRow, 'actionIds'>,
  broken: ReadonlySet<string> = new Set(),
): AppRecordAction[] {
  const allowed = new Set(row.actionIds);
  return (actions ?? []).filter((action) => allowed.has(action.id) && !broken.has(action.id));
}

/** The drawer's actions: the detail's, then the card-face ones not already listed. */
export function drawerActions(card: AppRecordsLikeCard): AppRecordAction[] {
  const detail = card.detail?.actions ?? [];
  const seen = new Set(detail.map((action) => action.id));
  return [...detail, ...(card.actions ?? []).filter((action) => !seen.has(action.id))];
}

/** Whether a declared action collects input in a dialog before it runs. */
export function actionInputFieldIds(action: AppRecordAction): number[] {
  return action.do.type === 'set_fields' ? (action.do.inputFieldIds ?? []) : [];
}

/** `open_url` targets the spec allows (the validator's rule): http(s) or an in-app `#/` link. */
export function isSafeAppUrl(url: string): boolean {
  return /^(https?:\/\/[^\s]+|#\/[^\s]*)$/i.test(url.trim());
}

/**
 * The days a calendar card asks the gateway for when it shows `month`
 * (`YYYY-MM`): the six weeks of the month grid, as the Phase 0 calendar view
 * loads them (`AppCardQueryInput.range`, inclusive local days).
 */
export function calendarCardRange(month: string, weekStart: 0 | 1): { from: string; to: string } {
  const days = monthGridDays(month, weekStart);
  return { from: days[0]!, to: days[days.length - 1]! };
}
