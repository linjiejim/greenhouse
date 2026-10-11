/**
 * The app gateway (docs/specs/20261011-tables-apps.md §3–§4): what an app's
 * audience — who need not be Base members — reads and does through
 * `/api/apps/:id/*`, evaluated live for their one role (D2, D3). Managers (Base
 * owner / builder) get the same endpoints with full access or `previewRole`.
 *
 * Every handler opens the app first (`openAppSession`: 404 when the caller is
 * neither a manager nor in the audience of the live version, or the app / Base
 * is archived), then finds the card on a page the role sees (404 otherwise),
 * then asks for the table under the kernel ceiling for its op
 * (`sessionTableAccess`: missing capability → 403 `not_allowed`; no rule for
 * the table → the card is `no_access` / 404). Data always goes through THE
 * compiler with an explicit scope: the role's compiled rule, narrowed to the
 * card (`cardReadScope`: the card query joins the read rows, readable fields
 * cut to what the card shows). Writes are `../app-actions.ts`.
 *
 * - `queryAppCard`: records-like cards page their records (`AppRecordRow` +
 *   refs + the actions each row allows now); kpi / chart / pivot evaluate their
 *   embedded `TableCardSpec` — both through `evaluateTableCard`, with the
 *   page's filters (targets the role cannot read dropped) and `$page.<id>`
 *   values; a card whose query needs an unreadable field is `no_access`; a
 *   broken one (D6) is `unavailable`.
 * - `getAppRecord`: the drawer — `detail.fieldIds` ∩ readable; editable =
 *   `detail.editableFieldIds` ∩ role editable, only inside its edit rows.
 * - `listAppActivity` / comments: history cut to readable ∩ drawer fields;
 *   comments only when `detail.comments` and the role `canComment`.
 * - `listAppFieldOptions`: people for user fields, rows the role reads for
 *   relation fields — only for fields the card lets the role write (or a
 *   people filter of the page).
 * - `uploadAppFile` / `getAppFile`: stage an attachment for a field the card
 *   lets the role write; download one only from a record and field the card
 *   shows the role.
 * - `getAppUsage` (managers): people and runs from the app-scoped audit and
 *   the action ledger.
 */

import { parseTableFieldConfig, resolveTableEvaluation, tableCommentView } from '@greenhouse/db';
import {
  type AppCardQueryResult,
  type AppFieldOptionsView,
  type AppRecordView,
  type AppRuntimeView,
  type AppSummary,
  type AppUsageView,
} from '@greenhouse/types/apps';
import type { TableDataScope } from '@greenhouse/types/table-access';
import { filterValueToGroups, trimCardForReader, type TableFieldTypeOf } from '@greenhouse/types/table-cards';
import type {
  TableCardSpec,
  TableFieldType,
  TableFilterGroup,
  TableRecordActivityPage,
  TableSystemField,
} from '@greenhouse/types/tables';
import { requireBase } from '../access.js';
import { cardWriteTargets, runSessionAction } from '../app-actions.js';
import { cardReadScope } from '../app-audience.js';
import { appRecordRefs, appRecordRow, availableActionIds, usableActions } from '../app-records.js';
import {
  cardActions,
  cardDetailFieldIds,
  cardDisplayFieldIds,
  cardShownFieldIds,
  cardSource,
  controlById,
  isAggregateCard,
  isRecordsCard,
  pageClauses,
  queryFieldIds,
  resolvePageRefs,
  type PageClause,
  type RecordsLikeCard,
} from '../app-scope.js';
import {
  locateSessionCard,
  openAppSession,
  sessionPageControls,
  sessionTableAccess,
  type AppSession,
  type LocatedCard,
} from '../app-session.js';
import { stageAppUpload } from '../app-uploads.js';
import { appSummary } from '../app-view.js';
import { roleRuntimeView } from '../app-viewer.js';
import { evaluateTableCard } from '../cards.js';
import { notifyCommentMentions, resolveMentionedUserIds } from '../mentions.js';
import { tablesManifest, type TablesActionId } from '../../manifests/tables.js';
import {
  fail,
  objectValue,
  ok,
  payloadOf,
  positiveInt,
  stringValue,
  type Handler,
  type HandlerRequest,
  type TablesHandlers,
} from './shared.js';

type Context = Parameters<Handler>[1];

const CARD_NOT_FOUND = () => fail('NOT_FOUND', 'Card not found');
const RECORD_NOT_FOUND = () => fail('NOT_FOUND', 'Record not found', { reason: 'not_found' });
const NOT_ALLOWED = (message = 'You do not have access to this data') =>
  fail('FORBIDDEN', message, { reason: 'not_allowed' });

/** Records a records-like card pages at a time, by kind (boards and calendars show more at once). */
const PAGE_SIZE: Readonly<Record<RecordsLikeCard['kind'], number>> = {
  records: 50,
  kanban: 200,
  calendar: 200,
  gallery: 50,
};
const MAX_SEARCH = 200;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Opened = { ok: true; session: AppSession; located: LocatedCard; payload: Record<string, unknown> };

/** Open the app and find the card (404 for either). */
async function openCard(
  request: HandlerRequest,
  context: Context,
): Promise<Opened | { ok: false; result: ReturnType<typeof fail> }> {
  const payload = payloadOf(request);
  const opened = await openAppSession(context, request, payload, positiveInt(payload, 'appId'));
  if (!opened.ok) return { ok: false, result: opened.result };
  const located = await locateSessionCard(opened.session, payload.pageId, payload.cardId);
  if (!located) return { ok: false, result: CARD_NOT_FOUND() };
  return { ok: true, session: opened.session, located, payload };
}

function viewerTimezone(payload: Record<string, unknown>): string | undefined {
  const value = stringValue(payload, 'timezone');
  return value && value.length <= 64 ? value : undefined;
}

function systemFieldFits(kind: string, field: TableSystemField): boolean {
  if (kind === 'date_range') return field === 'created_at' || field === 'updated_at';
  if (kind === 'user') return field === 'created_by' || field === 'updated_by';
  return false;
}

/** The issue message a viewer sees (managers see the validator's; it may name fields). */
function unavailableMessage(session: AppSession, located: LocatedCard): string {
  return session.manager ? (located.unavailable ?? '') : 'This card is unavailable';
}

// ─── getApp (viewer side) ─────────────────────────────────

/**
 * The runtime view for a viewer (their role, D3) or a manager previewing a
 * role: the role-trimmed published spec (`../app-viewer.ts`), field metadata,
 * issues. Undefined when the caller cannot open the app as a role.
 */
export async function roleAppView(
  request: HandlerRequest,
  context: Context,
  payload: Record<string, unknown>,
  appId: number | undefined,
  summary: (session: AppSession) => Promise<AppSummary>,
): Promise<ReturnType<typeof ok<AppRuntimeView>> | ReturnType<typeof fail>> {
  const opened = await openAppSession(context, request, payload, appId);
  if (!opened.ok) return opened.result;
  const view = await roleRuntimeView(opened.session, await summary(opened.session));
  return view ? ok(view) : fail('NOT_FOUND', 'App not found');
}

/** A viewer's app summary: they neither manage nor publish it. */
export async function viewerSummary(context: Context, session: AppSession): Promise<AppSummary> {
  const pins = await context.db.tables.listAppPins(session.userId);
  return appSummary(session.app, {
    canManage: session.manager,
    canPublish: session.owner,
    pinned: pins.some((pin) => pin.app_id === session.app.id),
  });
}

// ─── Card queries ─────────────────────────────────────────

const queryAppCard: Handler = async (request, context) => {
  const opened = await openCard(request, context);
  if (!opened.ok) return opened.result;
  const { session, located, payload } = opened;
  const { card, page } = located;
  if (payload.filterValues !== undefined && !objectValue(payload, 'filterValues')) {
    return fail('INVALID_INPUT', 'filterValues must be an object');
  }
  if (card.kind === 'text') return ok({ kind: 'text', markdown: card.markdown } satisfies AppCardQueryResult);
  if (!isRecordsCard(card) && !isAggregateCard(card)) return fail('INVALID_INPUT', 'This card has no data to query');
  if (located.unavailable) {
    return ok({ kind: 'unavailable', message: unavailableMessage(session, located) } satisfies AppCardQueryResult);
  }
  const source = cardSource(card);
  if (!source) return ok({ kind: 'unavailable', message: 'This card has no data source' } satisfies AppCardQueryResult);
  const tableId = source.tableId;
  const access = await sessionTableAccess(context, session, tableId, 'read');
  if (!access.ok) return access.reason === 'not_allowed' ? NOT_ALLOWED() : ok({ kind: 'no_access' });
  // Queries and aggregates need full `record.values` read (filters must not become an oracle).
  if (access.ceiling.read !== 'full') return ok({ kind: 'no_access' } satisfies AppCardQueryResult);

  const readable = new Set(access.scope.readableFieldIds);
  const controls = await sessionPageControls(session, page, located.brokenFilters);
  const timezone = viewerTimezone(payload);
  const { timeZone } = resolveTableEvaluation({ timeZone: timezone });
  const now = new Date();
  const filterValues = objectValue<Record<string, unknown>>(payload, 'filterValues');
  const fields = await session.fields(tableId);
  const byId = new Map(fields.map((field) => [field.id, field]));
  const fieldType: TableFieldTypeOf = ({ fieldId }) => byId.get(fieldId)?.type as TableFieldType | undefined;

  // `$page.<id>` clauses: the page filter's value on the clause's field (Phase 0 filter-control helpers).
  const resolvePage = ({ filterId, clause }: PageClause): TableFilterGroup[] => {
    const control = controlById(controls, filterId);
    if (!control) return [];
    if (clause.fieldId !== undefined && !readable.has(clause.fieldId)) return [];
    if (clause.systemField !== undefined && !systemFieldFits(control.kind, clause.systemField)) return [];
    const target =
      clause.systemField !== undefined
        ? { tableId, systemField: clause.systemField }
        : { tableId, fieldId: clause.fieldId! };
    const chosen = filterValues !== undefined && Object.prototype.hasOwnProperty.call(filterValues, control.id);
    let value = chosen ? filterValues[control.id] : control.defaultValue;
    const field = clause.fieldId !== undefined ? byId.get(clause.fieldId) : undefined;
    if (field && control.kind === 'select' && value && typeof value === 'object') {
      // Options the field no longer offers are dropped, never a failed card.
      const offered = new Set((parseTableFieldConfig(field).options ?? []).map((option) => option.id));
      const selected = (value as { values?: unknown }).values;
      value = { kind: 'select', values: Array.isArray(selected) ? selected.filter((id) => offered.has(id)) : [] };
    }
    return filterValueToGroups({ ...control, targets: [target] }, value, timeZone, { now, fieldType }).map(
      (entry) => entry.group,
    );
  };
  const query = resolvePageRefs(source.query, resolvePage);

  if (isAggregateCard(card)) {
    const embedded: TableCardSpec = { ...card.card, source: { tableId, query } };
    const trimmed = trimCardForReader(embedded, readable);
    if (!trimmed || queryFieldIds(source.query).some((id) => !readable.has(id))) {
      return ok({ kind: 'no_access' } satisfies AppCardQueryResult);
    }
    const result = await evaluateTableCard(
      context.db,
      trimmed,
      { controls, filterValues, timezone, now, fields },
      access.scope,
    );
    return ok(result as AppCardQueryResult);
  }

  const recordsCard = card as RecordsLikeCard;
  const essential = [
    ...queryFieldIds(recordsCard.source.query),
    ...(recordsCard.kind === 'kanban' ? [recordsCard.groupFieldId] : []),
    ...(recordsCard.kind === 'calendar' ? [recordsCard.startFieldId] : []),
  ];
  if (essential.some((id) => !readable.has(id))) return ok({ kind: 'no_access' } satisfies AppCardQueryResult);
  const display = cardDisplayFieldIds(recordsCard).filter((id) => readable.has(id));
  const filterTargets = controls.flatMap((control) =>
    control.targets.flatMap((target) =>
      target.tableId === tableId && target.fieldId !== undefined ? [target.fieldId] : [],
    ),
  );
  const pageFields = pageClauses(recordsCard.source.query).flatMap((ref) =>
    ref.clause.fieldId !== undefined ? [ref.clause.fieldId] : [],
  );
  const cardFields = new Set([...display, ...essential, ...filterTargets, ...pageFields]);
  // Search, the page's filters and the projection see the card's fields only.
  const evalScope: TableDataScope = {
    ...access.scope,
    readableFieldIds: access.scope.readableFieldIds.filter((id) => cardFields.has(id)),
  };

  const search = stringValue(payload, 'search')?.trim().slice(0, MAX_SEARCH);
  const range = objectValue<{ from?: unknown; to?: unknown }>(payload, 'range');
  const extra: TableFilterGroup[] = [];
  if (range && recordsCard.kind === 'calendar') {
    const clauses = [
      ...(typeof range.from === 'string' && DAY.test(range.from)
        ? [{ fieldId: recordsCard.startFieldId, operator: 'gte' as const, value: range.from }]
        : []),
      ...(typeof range.to === 'string' && DAY.test(range.to)
        ? [{ fieldId: recordsCard.startFieldId, operator: 'lte' as const, value: range.to }]
        : []),
    ];
    if (clauses.length > 0) extra.push({ combinator: 'and', clauses });
  }
  const spec: TableCardSpec = {
    kind: 'records',
    source: {
      tableId,
      query: {
        ...query,
        ...(search ? { search } : {}),
        ...(extra.length > 0 ? { filters: [...(query.filters ?? []), ...extra] } : {}),
      },
    },
    fieldIds: display,
    limit: PAGE_SIZE[recordsCard.kind],
  };
  const result = await evaluateTableCard(
    context.db,
    spec,
    { controls, filterValues, timezone, now, fields, cursor: stringValue(payload, 'cursor') },
    evalScope,
  );
  if (result.kind !== 'records') return ok(result as AppCardQueryResult);
  const rows = result.page.records;
  const editScope = cardReadScope(access.scope, recordsCard)!;
  const actions = usableActions(session, page.id, recordsCard.actions ?? [], located.brokenActions);
  const actionIds = await availableActionIds(
    context,
    session,
    recordsCard,
    editScope,
    actions,
    rows.map((row) => row.id),
  );
  const shown = new Set(display);
  return ok({
    kind: 'records',
    records: rows.map((row) => appRecordRow(row, shown, actionIds.get(row.id) ?? [])),
    total: result.page.total,
    nextCursor: result.page.nextCursor,
    refs: await appRecordRefs(context, session, tableId, rows, shown),
  } satisfies AppCardQueryResult);
};

// ─── One record ───────────────────────────────────────────

interface ReachedRecord {
  card: RecordsLikeCard;
  /** The card's read scope (role rows ∩ card query; readable = what the card shows). */
  scope: TableDataScope;
  /** Role-readable ∩ drawer fields; empty for a masked reader. */
  fields: number[];
  masked: boolean;
  record: Awaited<ReturnType<Context['db']['tables']['getRecord']>> & object;
}

/** A record inside a records-like card's scope, for reading. */
async function reachForRead(
  context: Context,
  session: AppSession,
  located: LocatedCard,
  recordId: number | undefined,
): Promise<{ ok: true; reached: ReachedRecord } | { ok: false; result: ReturnType<typeof fail> }> {
  const { card } = located;
  if (!isRecordsCard(card)) return { ok: false, result: fail('INVALID_INPUT', 'This card shows no records') };
  if (located.unavailable) return { ok: false, result: fail('NOT_FOUND', 'This card is unavailable') };
  if (!recordId) return { ok: false, result: fail('INVALID_INPUT', 'recordId is required') };
  const access = await sessionTableAccess(context, session, card.source.tableId, 'read');
  if (!access.ok) return { ok: false, result: access.reason === 'not_allowed' ? NOT_ALLOWED() : RECORD_NOT_FOUND() };
  if (access.ceiling.read === 'none') return { ok: false, result: RECORD_NOT_FOUND() };
  const scope = cardReadScope(access.scope, card);
  if (!scope) return { ok: false, result: RECORD_NOT_FOUND() };
  const record = await context.db.tables.getRecord(card.source.tableId, recordId, scope);
  if (!record) return { ok: false, result: RECORD_NOT_FOUND() };
  const masked = access.ceiling.read !== 'full';
  const readable = new Set(access.scope.readableFieldIds);
  const fields = masked ? [] : cardDetailFieldIds(card).filter((id) => readable.has(id));
  return { ok: true, reached: { card, scope, fields, masked, record } };
}

/** Comments are on for this card and role (`detail.comments` ∧ `role.canComment`; managers: `detail.comments`). */
function commentsOn(session: AppSession, card: RecordsLikeCard): boolean {
  return Boolean(card.detail?.comments) && (session.role ? session.role.canComment === true : true);
}

const getAppRecord: Handler = async (request, context) => {
  const opened = await openCard(request, context);
  if (!opened.ok) return opened.result;
  const { session, located, payload } = opened;
  const read = await reachForRead(context, session, located, positiveInt(payload, 'recordId'));
  if (!read.ok) return read.result;
  const { card, scope, fields, record } = read.reached;
  const tableId = card.source.tableId;

  let editableFieldIds: number[] = [];
  const wanted = card.detail?.editableFieldIds ?? [];
  if (wanted.length > 0) {
    const update = await sessionTableAccess(context, session, tableId, 'update');
    if (update.ok && update.ceiling.write && update.editable) {
      const editable = new Set(update.scope.editableFieldIds);
      const inEditRows = await context.db.tables.matchRecordIds(tableId, [record.id], scope, { purpose: 'edit' });
      if (inEditRows.has(record.id)) editableFieldIds = wanted.filter((id) => editable.has(id) && fields.includes(id));
    }
  }
  const comment = commentsOn(session, card) ? await session.ceiling('comment') : undefined;
  const actions = usableActions(session, located.page.id, cardActions(card), located.brokenActions);
  const actionIds =
    (await availableActionIds(context, session, card, scope, actions, [record.id])).get(record.id) ?? [];
  const shown = new Set(fields);
  const systemFields = card.detail?.systemFields ?? (card.kind === 'records' ? card.systemFields : undefined) ?? [];
  return ok({
    record: appRecordRow(record, shown, actionIds),
    refs: await appRecordRefs(context, session, tableId, [record], shown),
    fieldIds: fields,
    systemFields,
    editableFieldIds,
    canComment: Boolean(comment),
  } satisfies AppRecordView);
};

// ─── Actions ──────────────────────────────────────────────

const runAppAction: Handler = async (request, context) => {
  const opened = await openCard(request, context);
  if (!opened.ok) return opened.result;
  return runSessionAction(context, opened.session, opened.located, opened.payload);
};

// ─── Activity and comments ────────────────────────────────

const listAppActivity: Handler = async (request, context) => {
  const opened = await openCard(request, context);
  if (!opened.ok) return opened.result;
  const { session, located, payload } = opened;
  const read = await reachForRead(context, session, located, positiveInt(payload, 'recordId'));
  if (!read.ok) return read.result;
  const { card, scope, fields } = read.reached;
  const tableId = card.source.tableId;
  const visible = commentsOn(session, card);
  const comment = visible ? await session.ceiling('comment') : undefined;
  // History changes: the role's readable fields ∩ what the drawer shows (none for a masked reader).
  const readScope: TableDataScope = { ...scope, readableFieldIds: fields };
  const page = await context.db.tables.listRecordActivity(tableId, read.reached.record.id, scope, readScope, {
    cursor: stringValue(payload, 'cursor') || null,
    limit: positiveInt(payload, 'limit'),
    includeComments: visible,
  });
  if (!page) return RECORD_NOT_FOUND();
  return ok({
    ...page,
    viewer: {
      userId: session.userId,
      canComment: Boolean(comment),
      canModerate: Boolean(comment) && session.manager && !session.role,
    },
  } satisfies TableRecordActivityPage);
};

/** The card, record and scope a comment action works in; comments must be on and allowed. */
async function commentGate(
  context: Context,
  session: AppSession,
  located: LocatedCard,
  recordId: number | undefined,
): Promise<{ ok: true; reached: ReachedRecord } | { ok: false; result: ReturnType<typeof fail> }> {
  const read = await reachForRead(context, session, located, recordId);
  if (!read.ok) return read;
  if (!commentsOn(session, read.reached.card)) {
    return { ok: false, result: NOT_ALLOWED('Comments are not available here') };
  }
  if (!(await session.ceiling('comment'))) {
    return { ok: false, result: NOT_ALLOWED('Comments are not available here') };
  }
  return read;
}

const createAppComment: Handler = async (request, context) => {
  const opened = await openCard(request, context);
  if (!opened.ok) return opened.result;
  const { session, located, payload } = opened;
  const gate = await commentGate(context, session, located, positiveInt(payload, 'recordId'));
  if (!gate.ok) return gate.result;
  const { card, scope, record } = gate.reached;
  const body = stringValue(payload, 'body') ?? '';
  const comment = await context.db.tables.createComment(
    {
      tableId: card.source.tableId,
      recordId: record.id,
      authorId: session.userId,
      body,
      mentions: await resolveMentionedUserIds(context, body),
    },
    scope,
  );
  if (!comment) return RECORD_NOT_FOUND();
  await notifyCommentMentions(context, {
    base: session.base,
    tableId: card.source.tableId,
    recordId: record.id,
    comment,
    authorId: session.userId,
    userIds: comment.mentions,
  });
  return ok({ comment: tableCommentView(comment) });
};

/** A live comment on a record the card shows the caller. */
async function reachComment(context: Context, opened: Opened) {
  const { session, located, payload } = opened;
  const commentId = positiveInt(payload, 'commentId');
  if (!commentId) return { ok: false as const, result: fail('INVALID_INPUT', 'commentId is required') };
  const comment = await context.db.tables.getComment(commentId);
  const card = located.card;
  if (!comment || !isRecordsCard(card) || comment.table_id !== card.source.tableId) {
    return { ok: false as const, result: fail('NOT_FOUND', 'Comment not found') };
  }
  const gate = await commentGate(context, session, located, comment.record_id);
  if (!gate.ok) {
    // A record outside the card reads as a missing comment (no probing by comment id).
    const missing = !gate.result.ok && gate.result.code === 'NOT_FOUND';
    return { ok: false as const, result: missing ? fail('NOT_FOUND', 'Comment not found') : gate.result };
  }
  return { ok: true as const, comment, scope: gate.reached.scope, card };
}

const updateAppComment: Handler = async (request, context) => {
  const opened = await openCard(request, context);
  if (!opened.ok) return opened.result;
  const reached = await reachComment(context, opened);
  if (!reached.ok) return reached.result;
  const { session } = opened;
  if (reached.comment.author_id !== session.userId) return NOT_ALLOWED('Only the author can edit a comment');
  const body = stringValue(opened.payload, 'body') ?? '';
  const updated = await context.db.tables.updateComment(
    reached.comment.id,
    { body, mentions: await resolveMentionedUserIds(context, body) },
    reached.scope,
  );
  if (!updated) return fail('NOT_FOUND', 'Comment not found');
  const before = new Set(reached.comment.mentions);
  await notifyCommentMentions(context, {
    base: session.base,
    tableId: updated.table_id,
    recordId: updated.record_id,
    comment: updated,
    authorId: session.userId,
    userIds: updated.mentions.filter((id) => !before.has(id)),
  });
  return ok({ comment: tableCommentView(updated) });
};

const deleteAppComment: Handler = async (request, context) => {
  const opened = await openCard(request, context);
  if (!opened.ok) return opened.result;
  const reached = await reachComment(context, opened);
  if (!reached.ok) return reached.result;
  const { session } = opened;
  const moderates = session.manager && !session.role;
  if (reached.comment.author_id !== session.userId && !moderates) {
    return NOT_ALLOWED('Only the author can delete a comment');
  }
  const deleted = await context.db.tables.deleteComment(reached.comment.id, reached.scope);
  return deleted ? ok({ deleted: true, commentId: reached.comment.id }) : fail('NOT_FOUND', 'Comment not found');
};

// ─── Field options ────────────────────────────────────────

const MAX_OPTIONS = 50;

async function peopleOptions(context: Context, search: string): Promise<AppFieldOptionsView['options']> {
  const needle = search.toLowerCase();
  return (await context.db.users.list())
    .filter((user) => user.status === 'active' && (user.role === 'team' || user.role === 'super'))
    .filter(
      (user) => !needle || user.nickname.toLowerCase().includes(needle) || user.email.toLowerCase().includes(needle),
    )
    .sort((a, b) => a.nickname.localeCompare(b.nickname))
    .slice(0, MAX_OPTIONS)
    .map((user) => ({ value: user.id, label: user.nickname, detail: user.email }));
}

const listAppFieldOptions: Handler = async (request, context) => {
  const opened = await openCard(request, context);
  if (!opened.ok) return opened.result;
  const { session, located, payload } = opened;
  const fieldId = positiveInt(payload, 'fieldId');
  if (!fieldId) return fail('INVALID_INPUT', 'fieldId is required');
  const search = (stringValue(payload, 'search') ?? '').trim().slice(0, MAX_SEARCH);
  const facts = await session.facts();
  const field = facts.fields.find((entry) => entry.id === fieldId);
  if (!field) return fail('NOT_FOUND', 'Field not found');

  // A field the card lets the role write …
  let writable = false;
  const buttonId = stringValue(payload, 'buttonId');
  for (const target of cardWriteTargets(session, located, buttonId)) {
    if (target.tableId !== field.tableId || !target.fieldIds.includes(fieldId)) continue;
    const access = await sessionTableAccess(context, session, target.tableId, target.op);
    if (access.ok && access.ceiling.write && access.scope.editableFieldIds.includes(fieldId)) {
      writable = true;
      break;
    }
  }
  // … or the target of a people filter on the page.
  const filtered =
    !writable &&
    (field.type === 'user' || field.type === 'multi_user') &&
    (await sessionPageControls(session, located.page, located.brokenFilters)).some(
      (control) => control.kind === 'user' && control.targets.some((target) => target.fieldId === fieldId),
    );
  if (!writable && !filtered) return fail('NOT_FOUND', 'Field not found on this card');

  if (field.type === 'user' || field.type === 'multi_user') {
    return ok({ options: await peopleOptions(context, search) } satisfies AppFieldOptionsView);
  }
  if (field.type === 'relation' && field.relationTargetTableId) {
    const targetTableId = field.relationTargetTableId;
    const access = await sessionTableAccess(context, session, targetTableId, 'read');
    // Only rows the role reads on the target table (the write accepts nothing else, D14).
    if (!access.ok || access.ceiling.read !== 'full') return ok({ options: [] } satisfies AppFieldOptionsView);
    const primary = facts.fields.find((entry) => entry.tableId === targetTableId && entry.isPrimary);
    const readsPrimary = primary ? access.scope.readableFieldIds.includes(primary.id) : false;
    const page = await context.db.tables.queryRecords(
      targetTableId,
      { limit: MAX_OPTIONS, ...(search ? { search } : {}) },
      access.scope,
    );
    return ok({
      options: page.records.map((row) => {
        const key = primary ? String(primary.id) : '';
        const raw = readsPrimary ? (row.computed_values[key] ?? row.values[key]) : undefined;
        const label = raw === undefined || raw === null || raw === '' ? `#${row.id}` : String(raw);
        return { value: row.id, label };
      }),
    } satisfies AppFieldOptionsView);
  }
  return fail('INVALID_INPUT', 'Options are listed for people and linked-record fields only');
};

// ─── Files ────────────────────────────────────────────────

const uploadAppFile: Handler = async (request, context) => {
  const opened = await openCard(request, context);
  if (!opened.ok) return opened.result;
  const { session, located, payload } = opened;
  const fieldId = positiveInt(payload, 'fieldId');
  const file = payload.file;
  if (!fieldId || !(file instanceof File)) return fail('INVALID_INPUT', 'fieldId and file are required');
  if (located.unavailable) return NOT_ALLOWED('This card is unavailable');
  const field = (await session.facts()).fields.find((entry) => entry.id === fieldId);
  if (!field || field.type !== 'attachment') return fail('INVALID_INPUT', 'This field does not take files');
  let allowed = false;
  for (const target of cardWriteTargets(session, located)) {
    if (target.tableId !== field.tableId || !target.fieldIds.includes(fieldId)) continue;
    const access = await sessionTableAccess(context, session, target.tableId, target.op);
    if (!access.ok || !access.ceiling.write || !access.scope.editableFieldIds.includes(fieldId)) continue;
    if (target.op === 'create' ? access.scope.canCreate : access.editable) {
      allowed = true;
      break;
    }
  }
  if (!allowed) return NOT_ALLOWED('This card does not take files for that field');
  const staged = await stageAppUpload(context.db, session, file);
  if (!staged.ok) {
    return fail('INVALID_INPUT', staged.error, staged.reason ? { reason: staged.reason } : undefined);
  }
  return ok({ file: staged.file });
};

const getAppFile: Handler = async (request, context) => {
  const opened = await openCard(request, context);
  if (!opened.ok) return opened.result;
  const { session, located, payload } = opened;
  const fileId = positiveInt(payload, 'fileId');
  const fieldId = positiveInt(payload, 'fieldId');
  if (!fileId || !fieldId) return fail('INVALID_INPUT', 'fileId and fieldId are required');
  const read = await reachForRead(context, session, located, positiveInt(payload, 'recordId'));
  if (!read.ok) return fail('NOT_FOUND', 'File not found');
  const { card, record } = read.reached;
  const readable = new Set(read.reached.scope.readableFieldIds);
  const field = (await session.facts()).fields.find((entry) => entry.id === fieldId);
  if (
    read.reached.masked ||
    !field ||
    field.type !== 'attachment' ||
    !readable.has(fieldId) ||
    !cardShownFieldIds(card).includes(fieldId)
  ) {
    return fail('NOT_FOUND', 'File not found');
  }
  const attached = await context.db.tables.listRecordAttachments(record.id, fieldId);
  if (!attached.some((row) => row.drive_file_id === fileId)) return fail('NOT_FOUND', 'File not found');
  return ok({ fileId });
};

// ─── Usage ────────────────────────────────────────────────

/** Gateway actions that count as using an app (managers' own builder work does not). */
const USE_ACTIONS = [
  'getApp',
  'queryAppCard',
  'getAppRecord',
  'runAppAction',
  'listAppActivity',
  'createAppComment',
  'updateAppComment',
  'deleteAppComment',
  'listAppFieldOptions',
  'uploadAppFile',
  'getAppFile',
] as const satisfies readonly TablesActionId[];

const getAppUsage: Handler = async (request, context) => {
  const appId = positiveInt(payloadOf(request), 'appId');
  const app = appId ? await context.db.tables.getApp(appId) : undefined;
  if (!app || !(await requireBase(context, request.actor, app.base_id, 'app', 'builder'))) {
    return fail('NOT_FOUND', 'App not found');
  }
  const counts = await context.db.tables.appUsageSummary(app.id, {
    orgId: request.actor.orgId,
    appKey: tablesManifest.id,
    useActionIds: USE_ACTIONS,
  });
  return ok({
    users7d: counts.users7d,
    users30d: counts.users30d,
    actions30d: counts.actions30d,
    lastUsedAt: counts.lastUsedAt,
  } satisfies AppUsageView);
};

export const appGatewayHandlers = {
  queryAppCard,
  getAppRecord,
  runAppAction,
  listAppActivity,
  createAppComment,
  updateAppComment,
  deleteAppComment,
  listAppFieldOptions,
  uploadAppFile,
  getAppFile,
  getAppUsage,
} satisfies TablesHandlers;
