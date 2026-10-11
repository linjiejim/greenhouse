/**
 * App writes — `POST /api/apps/:id/actions` (docs/specs/20261011-tables-apps.md
 * §3 动作授权, D8). One entry for declared actions (`set_fields`, `delete`,
 * `run_automation`) and the built-ins (`$submit`, `$create`, `$move`, `$edit`).
 *
 * An action runs only when ALL hold:
 * - its card is on a page the role sees and is not broken (D6); the action
 *   lists the role (default: every role that sees the page) and is not broken;
 *   a form / create spec / move / button lists the role;
 * - the kernel allows the op (`tables.data.create|update|delete`, the `record`
 *   entity scope, `record.values` write) and the role's rule does: create needs
 *   `rule.create`, delete `rule.delete`, updates and automations `access: 'edit'`;
 * - the record is inside the card's scope (role read rows ∩ card query) — else
 *   404 — and its edit rows — else 403;
 * - every key written is editable for the role (spec constants of a create may
 *   fill fields the role cannot edit); the client sends values only for the
 *   action's inputs (`inputFieldIds`, the form / create / drawer fields, the
 *   lane field), required inputs must be filled (400 `required_input`);
 * - `when` holds inside the write transaction against the current row: it
 *   joins the write's edit rows, so the locking read finds nothing when it no
 *   longer holds (409 `precondition`); a stale revision is 409 `conflict`.
 * Direct writes run as the viewer (`created_by` = them, history
 * `actorKind: 'app'`, `source.appId`); `run_automation` queues the rule's
 * button run, executed asynchronously as the rule's executor (Phase 0 D17).
 * `$me` / `$now` / `$today` in spec values are resolved here. A repeated
 * `requestId` replays the first result (`replayed: true`) instead of writing again.
 */

import {
  APP_USAGE_WINDOW_DAYS,
  isTablesForbiddenError,
  TablesValidationError,
  type DatabaseProvider,
  type TableRecordRow,
} from '@greenhouse/db';
import { expandDateToken } from '@greenhouse/types/date-tokens';
import {
  APP_BUILTIN_ACTIONS,
  type AppActionRefusal,
  type AppActionResult,
  type AppCard,
  type AppRecordAction,
  type AppRecordRow,
} from '@greenhouse/types/apps';
import type { TableDataScope, TableRowScope } from '@greenhouse/types/table-access';
import type { TableFieldValueEntry, TableFilterGroup, TableRecordValues } from '@greenhouse/types/tables';
import type { PlatformActionResult } from '@greenhouse/platform-kernel';
import { cardReadScope } from './app-audience.js';
import { appRecordRow, availableActionIds, usableActions } from './app-records.js';
import { cardActions, cardDisplayFieldIds, isRecordsCard, type RecordsLikeCard } from './app-scope.js';
import { sessionRoleAllows, sessionTableAccess, type AppSession, type LocatedCard } from './app-session.js';
import { claimAppAttachments } from './app-uploads.js';
import { publishRecordsChanged } from './realtime.js';
import { fail, ok, writeMeta, type Handler } from './handlers/shared.js';

type Context = Parameters<Handler>[1];

export const APP_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

/** How long a repeat of an in-flight request waits for the first one's result. */
const REPLAY_WAIT_MS = 5_000;
const REPLAY_POLL_MS = 100;

function refuse(
  code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN',
  reason: AppActionRefusal,
  message: string,
  extra: Record<string, unknown> = {},
): PlatformActionResult {
  return fail(code, message, { reason, ...extra });
}

const NOT_FOUND = () => refuse('NOT_FOUND', 'not_found', 'Record not found');
const NOT_ALLOWED = (message = 'This action is not allowed here') => refuse('FORBIDDEN', 'not_allowed', message);

// ─── What a card lets the role write ──────────────────────

export interface CardWriteTarget {
  tableId: number;
  op: 'create' | 'update';
  /** Fields the client may send (still ∩ the role's editable fields). */
  fieldIds: number[];
}

/**
 * Every place a card lets the role in play write, with the fields it may send:
 * a form, a records card's create spec, the drawer's editable fields, the
 * inputs of the actions it may use, a kanban lane change, `create_record`
 * buttons (only `buttonId` when given). Uploads and field options read this.
 */
export function cardWriteTargets(session: AppSession, located: LocatedCard, buttonId?: string): CardWriteTarget[] {
  const { card, page } = located;
  const out: CardWriteTarget[] = [];
  if (card.kind === 'form' && sessionRoleAllows(session, card.roles)) {
    out.push({ tableId: card.tableId, op: 'create', fieldIds: card.fieldIds });
  }
  if (card.kind === 'buttons') {
    for (const button of card.buttons) {
      if (button.type !== 'create_record' || (buttonId !== undefined && button.id !== buttonId)) continue;
      if (located.brokenActions.has(button.id) || !sessionRoleAllows(session, button.roles)) continue;
      out.push({ tableId: button.tableId, op: 'create', fieldIds: button.fieldIds });
    }
  }
  if (isRecordsCard(card)) {
    const tableId = card.source.tableId;
    if (card.kind === 'records' && card.create && sessionRoleAllows(session, card.create.roles)) {
      out.push({ tableId, op: 'create', fieldIds: card.create.fieldIds });
    }
    if (card.detail?.editableFieldIds?.length) {
      out.push({ tableId, op: 'update', fieldIds: card.detail.editableFieldIds });
    }
    if (card.kind === 'kanban' && card.move && sessionRoleAllows(session, card.move.roles)) {
      out.push({ tableId, op: 'update', fieldIds: [card.groupFieldId] });
    }
    for (const action of usableActions(session, page.id, cardActions(card), located.brokenActions)) {
      if (action.do.type === 'set_fields' && action.do.inputFieldIds?.length) {
        out.push({ tableId, op: 'update', fieldIds: action.do.inputFieldIds });
      }
    }
  }
  return out;
}

// ─── Values ───────────────────────────────────────────────

/** The client's `values` entries, or undefined when malformed. */
export function clientValues(raw: unknown): TableFieldValueEntry[] | undefined {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 100) return undefined;
  const out: TableFieldValueEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return undefined;
    const { fieldId, value } = entry as { fieldId?: unknown; value?: unknown };
    if (typeof fieldId !== 'number' || !Number.isInteger(fieldId) || fieldId <= 0) return undefined;
    out.push({ fieldId, value: value === undefined ? null : value });
  }
  return out;
}

/** Spec values with `$me` / `$now` / `$today` resolved for this viewer, in their zone. */
function resolveSpecValues(
  entries: readonly TableFieldValueEntry[],
  fieldTypes: ReadonlyMap<number, string>,
  input: { userId: string; now: Date; timeZone: string },
): TableRecordValues {
  const values: TableRecordValues = {};
  for (const entry of entries) {
    const type = fieldTypes.get(entry.fieldId);
    let value = entry.value;
    if (value === '$me') {
      value = type === 'multi_user' ? [input.userId] : input.userId;
    } else if (value === '$now') {
      value = type === 'date' ? expandDateToken('$today', input.now, input.timeZone) : input.now.toISOString();
    } else if (value === '$today') {
      value = expandDateToken('$today', input.now, input.timeZone);
    }
    values[String(entry.fieldId)] = value;
  }
  return values;
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function whenRows(when: TableFilterGroup | undefined): TableRowScope[] {
  return when && Array.isArray(when.clauses) && when.clauses.length > 0 ? [{ type: 'where', where: when }] : [];
}

function validTimeZone(zone: unknown): string {
  if (typeof zone !== 'string' || zone.length > 64) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

// ─── The plan ─────────────────────────────────────────────

type Plan =
  | {
      kind: 'create';
      tableId: number;
      inputs: number[];
      defaults: TableFieldValueEntry[];
      /** The records card a created row is shown in (for the result), if any. */
      shownIn?: RecordsLikeCard;
    }
  | {
      kind: 'update';
      card: RecordsLikeCard;
      inputs: number[];
      requiredInputs: number[];
      constants: TableFieldValueEntry[];
      when?: TableFilterGroup;
      /** `$move` must change exactly the lane field. */
      exact?: boolean;
    }
  | { kind: 'delete'; card: RecordsLikeCard; when?: TableFilterGroup }
  | { kind: 'automation'; card: RecordsLikeCard; ruleId: number; when?: TableFilterGroup };

function planFor(
  session: AppSession,
  located: LocatedCard,
  actionId: string,
  buttonId: string | undefined,
): Plan | PlatformActionResult {
  const { card, page } = located;
  switch (actionId) {
    case APP_BUILTIN_ACTIONS.submit:
      if (card.kind !== 'form') return refuse('INVALID_INPUT', 'not_allowed', 'This card is not a form');
      if (!sessionRoleAllows(session, card.roles)) return NOT_ALLOWED();
      return { kind: 'create', tableId: card.tableId, inputs: card.fieldIds, defaults: card.defaults ?? [] };
    case APP_BUILTIN_ACTIONS.create: {
      if (buttonId !== undefined) {
        const button = card.kind === 'buttons' ? card.buttons.find((entry) => entry.id === buttonId) : undefined;
        if (!button || button.type !== 'create_record') return refuse('NOT_FOUND', 'not_found', 'Button not found');
        if (located.brokenActions.has(button.id) || !sessionRoleAllows(session, button.roles)) return NOT_ALLOWED();
        return { kind: 'create', tableId: button.tableId, inputs: button.fieldIds, defaults: button.defaults ?? [] };
      }
      if (card.kind !== 'records' || !card.create) return NOT_ALLOWED('This card does not create records');
      if (!sessionRoleAllows(session, card.create.roles)) return NOT_ALLOWED();
      return {
        kind: 'create',
        tableId: card.source.tableId,
        inputs: card.create.fieldIds,
        defaults: card.create.defaults ?? [],
        shownIn: card,
      };
    }
    case APP_BUILTIN_ACTIONS.move:
      if (card.kind !== 'kanban' || !card.move || !sessionRoleAllows(session, card.move.roles)) {
        return NOT_ALLOWED('Cards on this board cannot be moved');
      }
      return {
        kind: 'update',
        card,
        inputs: [card.groupFieldId],
        requiredInputs: [],
        constants: [],
        when: card.move.when,
        exact: true,
      };
    case APP_BUILTIN_ACTIONS.edit:
      if (!isRecordsCard(card) || !card.detail?.editableFieldIds?.length) {
        return NOT_ALLOWED('Records on this card cannot be edited');
      }
      return { kind: 'update', card, inputs: card.detail.editableFieldIds, requiredInputs: [], constants: [] };
    default: {
      if (!isRecordsCard(card)) return refuse('NOT_FOUND', 'not_found', 'Action not found');
      const action: AppRecordAction | undefined = cardActions(card).find((entry) => entry.id === actionId);
      if (!action) return refuse('NOT_FOUND', 'not_found', 'Action not found');
      if (usableActions(session, page.id, [action], located.brokenActions).length === 0) return NOT_ALLOWED();
      switch (action.do.type) {
        case 'set_fields':
          return {
            kind: 'update',
            card,
            inputs: action.do.inputFieldIds ?? [],
            requiredInputs: action.do.requiredInputFieldIds ?? [],
            constants: action.do.values,
            when: action.when,
          };
        case 'delete':
          return { kind: 'delete', card, when: action.when };
        case 'run_automation':
          return { kind: 'automation', card, ruleId: action.do.ruleId, when: action.when };
      }
    }
  }
}

function isPlan(value: Plan | PlatformActionResult): value is Plan {
  return 'kind' in value;
}

// ─── Execution ────────────────────────────────────────────

interface Request {
  located: LocatedCard;
  actionId: string;
  recordId?: number;
  revision?: number;
  values: TableFieldValueEntry[];
  requestId: string;
  timeZone: string;
}

async function fieldTypes(session: AppSession, tableId: number): Promise<Map<number, string>> {
  const facts = await session.facts();
  return new Map(facts.fields.filter((field) => field.tableId === tableId).map((field) => [field.id, field.type]));
}

async function attachmentFields(session: AppSession, tableId: number): Promise<Set<number>> {
  const facts = await session.facts();
  return new Set(
    facts.fields.filter((field) => field.tableId === tableId && field.type === 'attachment').map((field) => field.id),
  );
}

function meta(session: AppSession) {
  return writeMeta(session.actor, { actorKind: 'app', source: { appId: session.app.id } });
}

/** The written row as the viewer now reads it through `card` (undefined when it left the card's scope). */
async function rowAfterWrite(
  context: Context,
  session: AppSession,
  card: RecordsLikeCard,
  pageId: string,
  recordId: number,
): Promise<AppRecordRow | undefined> {
  const access = await sessionTableAccess(context, session, card.source.tableId, 'read');
  if (!access.ok || access.ceiling.read !== 'full') return undefined;
  const scope = cardReadScope(access.scope, card);
  if (!scope) return undefined;
  const row = await context.db.tables.getRecord(card.source.tableId, recordId, scope);
  if (!row) return undefined;
  const actions = usableActions(session, pageId, card.actions ?? [], new Set());
  const ids = await availableActionIds(context, session, card, scope, actions, [row.id]);
  const readable = new Set(scope.readableFieldIds);
  const shown = new Set(cardDisplayFieldIds(card).filter((id) => readable.has(id)));
  return appRecordRow(row, shown, ids.get(row.id) ?? []);
}

async function runCreate(
  context: Context,
  session: AppSession,
  request: Request,
  plan: Extract<Plan, { kind: 'create' }>,
): Promise<PlatformActionResult> {
  const access = await sessionTableAccess(context, session, plan.tableId, 'create');
  if (!access.ok || !access.ceiling.write || !access.scope.canCreate) return NOT_ALLOWED('You cannot add records here');
  const editable = new Set(access.scope.editableFieldIds);
  const inputs = new Set(plan.inputs.filter((id) => editable.has(id)));
  const blocked = request.values.find((entry) => !inputs.has(entry.fieldId));
  if (blocked) return NOT_ALLOWED(`Field ${blocked.fieldId} cannot be written here`);
  const types = await fieldTypes(session, plan.tableId);
  const values: TableRecordValues = {};
  for (const entry of request.values) values[String(entry.fieldId)] = entry.value;
  // The spec's defaults win over anything the client sent (they are the builder's, not the viewer's).
  Object.assign(
    values,
    resolveSpecValues(plan.defaults, types, { userId: session.userId, now: new Date(), timeZone: request.timeZone }),
  );
  const defaultKeys = plan.defaults.map((entry) => entry.fieldId);
  const facts = await session.facts();
  const relationTargets = [...(access.scope.relationTargets ?? [])];
  for (const fieldId of defaultKeys) {
    const target = facts.fields.find((field) => field.id === fieldId)?.relationTargetTableId;
    if (target && !relationTargets.some((entry) => entry.tableId === target)) {
      relationTargets.push({ tableId: target, rows: [] });
    }
  }
  const scope: TableDataScope = {
    ...access.scope,
    editableFieldIds: [...new Set([...inputs, ...defaultKeys])],
    relationTargets,
  };
  const claim = await claimAppAttachments(context.db, session, {
    attachmentFieldIds: await attachmentFields(session, plan.tableId),
    values,
    current: null,
    recordId: null,
  });
  if (!claim.ok) return fail('INVALID_INPUT', claim.error);
  let record: TableRecordRow;
  try {
    record = await context.db.tables.createRecord({ table_id: plan.tableId, values }, scope, meta(session));
  } catch (error) {
    await context.db.tables.releaseAppUploads(claim.claimed);
    throw error;
  }
  await publishRecordsChanged(context, session.base, plan.tableId, [record.id]);
  const shown = plan.shownIn
    ? await rowAfterWrite(context, session, plan.shownIn, request.located.page.id, record.id)
    : undefined;
  return ok({
    outcome: 'created',
    recordId: record.id,
    ...(shown ? { record: shown } : {}),
  } satisfies AppActionResult);
}

/**
 * The record inside the card's scope and edit rows (pre-checks: 404 outside the
 * card, 403 outside the edit rows), with the card scope writes go through.
 */
async function reachRecord(
  context: Context,
  session: AppSession,
  card: RecordsLikeCard,
  op: 'update' | 'delete',
  recordId: number | undefined,
): Promise<
  | { ok: true; scope: TableDataScope; editable: boolean; current: TableRecordRow; canDelete: boolean }
  | { ok: false; result: PlatformActionResult }
> {
  if (!recordId) return { ok: false, result: fail('INVALID_INPUT', 'recordId is required') };
  const tableId = card.source.tableId;
  const access = await sessionTableAccess(context, session, tableId, op);
  if (!access.ok) {
    return { ok: false, result: access.reason === 'no_access' ? NOT_FOUND() : NOT_ALLOWED() };
  }
  // Kernel `record.values`: an update writes values; a delete needs full read (as on /api/tables).
  if (op === 'update' ? !access.ceiling.write : access.ceiling.read !== 'full') {
    return { ok: false, result: NOT_ALLOWED() };
  }
  const scope = cardReadScope(access.scope, card);
  if (!scope) return { ok: false, result: NOT_FOUND() };
  // Writes keep the role's editable fields (the read cut is for display).
  const writeScope: TableDataScope = { ...scope, readableFieldIds: access.scope.readableFieldIds };
  const current = await context.db.tables.getRecord(tableId, recordId, writeScope);
  if (!current) return { ok: false, result: NOT_FOUND() };
  const editRows = await context.db.tables.matchRecordIds(tableId, [recordId], writeScope, { purpose: 'edit' });
  if (!editRows.has(recordId)) return { ok: false, result: NOT_ALLOWED('You cannot change this record') };
  return { ok: true, scope: writeScope, editable: access.editable, current, canDelete: access.scope.canDelete };
}

/** After a refused locking read: the row is still there → `when` no longer holds; else it is gone. */
async function preconditionOrGone(
  context: Context,
  scope: TableDataScope,
  recordId: number,
  hadWhen: boolean,
): Promise<PlatformActionResult> {
  const still = await context.db.tables.getRecord(scope.tableId, recordId, scope);
  if (still && hadWhen) return refuse('CONFLICT', 'precondition', 'This action no longer applies to the record');
  return NOT_FOUND();
}

async function runUpdate(
  context: Context,
  session: AppSession,
  request: Request,
  plan: Extract<Plan, { kind: 'update' }>,
): Promise<PlatformActionResult> {
  const reached = await reachRecord(context, session, plan.card, 'update', request.recordId);
  if (!reached.ok) return reached.result;
  if (!reached.editable) return NOT_ALLOWED('You cannot change this record');
  const tableId = plan.card.source.tableId;
  const editable = new Set(reached.scope.editableFieldIds);
  const inputs = new Set(plan.inputs);
  const blocked = request.values.find((entry) => !inputs.has(entry.fieldId) || !editable.has(entry.fieldId));
  if (blocked) return NOT_ALLOWED(`Field ${blocked.fieldId} cannot be written here`);
  const keys = [...new Set([...plan.constants.map((entry) => entry.fieldId), ...request.values.map((e) => e.fieldId)])];
  if (keys.some((key) => !editable.has(key))) return NOT_ALLOWED('This action writes a field you cannot edit');
  if (plan.exact && (request.values.length !== 1 || request.values[0]!.fieldId !== plan.inputs[0])) {
    return fail('INVALID_INPUT', 'Moving a card changes only its lane');
  }
  if (keys.length === 0) return fail('INVALID_INPUT', 'Nothing to change');
  const sent = new Map(request.values.map((entry) => [entry.fieldId, entry.value]));
  const missing = plan.requiredInputs.filter((id) => isEmptyValue(sent.get(id)));
  if (missing.length > 0) {
    return refuse('INVALID_INPUT', 'required_input', 'Fill in the required fields', { fieldIds: missing });
  }
  const values: TableRecordValues = {};
  for (const entry of request.values) values[String(entry.fieldId)] = entry.value;
  Object.assign(
    values,
    resolveSpecValues(plan.constants, await fieldTypes(session, tableId), {
      userId: session.userId,
      now: new Date(),
      timeZone: request.timeZone,
    }),
  );
  const claim = await claimAppAttachments(context.db, session, {
    attachmentFieldIds: await attachmentFields(session, tableId),
    values,
    current: reached.current.values,
    recordId: reached.current.id,
  });
  if (!claim.ok) return fail('INVALID_INPUT', claim.error);
  // `when` joins the edit rows: the locking read inside the write finds the
  // row only while it still holds. Only this write's keys count as editable,
  // so a required field it does not touch cannot fail it (D3).
  const scope: TableDataScope = {
    ...reached.scope,
    editRows: [...reached.scope.editRows, ...whenRows(plan.when)],
    editableFieldIds: keys,
  };
  let result: Awaited<ReturnType<typeof context.db.tables.updateRecord>>;
  try {
    result = await context.db.tables.updateRecord(
      {
        table_id: tableId,
        record_id: reached.current.id,
        revision: request.revision ?? reached.current.revision,
        values,
      },
      scope,
      meta(session),
    );
  } catch (error) {
    await context.db.tables.releaseAppUploads(claim.claimed);
    throw error;
  }
  if (!result.ok) {
    await context.db.tables.releaseAppUploads(claim.claimed);
    if (result.reason === 'conflict') {
      return refuse('CONFLICT', 'conflict', 'The record changed since you loaded it', {
        currentRevision: result.current,
      });
    }
    return preconditionOrGone(context, reached.scope, reached.current.id, whenRows(plan.when).length > 0);
  }
  await publishRecordsChanged(context, session.base, tableId, [result.record.id]);
  const shown = await rowAfterWrite(context, session, plan.card, request.located.page.id, result.record.id);
  return ok({
    outcome: 'updated',
    recordId: result.record.id,
    ...(shown ? { record: shown } : {}),
  } satisfies AppActionResult);
}

async function runDelete(
  context: Context,
  session: AppSession,
  request: Request,
  plan: Extract<Plan, { kind: 'delete' }>,
): Promise<PlatformActionResult> {
  const reached = await reachRecord(context, session, plan.card, 'delete', request.recordId);
  if (!reached.ok) return reached.result;
  if (!reached.canDelete) return NOT_ALLOWED('You cannot delete this record');
  const tableId = plan.card.source.tableId;
  const scope: TableDataScope = { ...reached.scope, editRows: [...reached.scope.editRows, ...whenRows(plan.when)] };
  const result = await context.db.tables.deleteRecord(
    { table_id: tableId, record_id: reached.current.id, revision: request.revision ?? reached.current.revision },
    scope,
    meta(session),
  );
  if (!result.ok) {
    if (result.reason === 'conflict') {
      return refuse('CONFLICT', 'conflict', 'The record changed since you loaded it', {
        currentRevision: result.current,
      });
    }
    return preconditionOrGone(context, reached.scope, reached.current.id, whenRows(plan.when).length > 0);
  }
  await publishRecordsChanged(context, session.base, tableId, [result.record.id]);
  return ok({ outcome: 'deleted', recordId: result.record.id } satisfies AppActionResult);
}

async function runAutomation(
  context: Context,
  session: AppSession,
  request: Request,
  plan: Extract<Plan, { kind: 'automation' }>,
): Promise<PlatformActionResult> {
  const reached = await reachRecord(context, session, plan.card, 'update', request.recordId);
  if (!reached.ok) return reached.result;
  if (!reached.editable) return NOT_ALLOWED('You cannot run this on the record');
  const tableId = plan.card.source.tableId;
  if (whenRows(plan.when).length > 0) {
    const holds = await context.db.tables.matchRecordIds(tableId, [reached.current.id], reached.scope, {
      purpose: 'edit',
      condition: plan.when,
    });
    if (!holds.has(reached.current.id)) {
      return refuse('CONFLICT', 'precondition', 'This action no longer applies to the record');
    }
  }
  const queued = await context.db.tables.enqueueButtonRun({
    ruleId: plan.ruleId,
    tableId,
    recordId: reached.current.id,
    actorId: session.userId,
    requestId: request.requestId,
  });
  if (!queued.ok) {
    return queued.reason === 'condition_not_met'
      ? refuse('CONFLICT', 'precondition', 'The automation does not apply to the record any more')
      : NOT_ALLOWED('This automation is not available');
  }
  return ok({ outcome: 'queued', recordId: reached.current.id } satisfies AppActionResult);
}

async function execute(context: Context, session: AppSession, request: Request, plan: Plan) {
  try {
    switch (plan.kind) {
      case 'create':
        return await runCreate(context, session, request, plan);
      case 'update':
        return await runUpdate(context, session, request, plan);
      case 'delete':
        return await runDelete(context, session, request, plan);
      case 'automation':
        return await runAutomation(context, session, request, plan);
    }
  } catch (error) {
    if (isTablesForbiddenError(error)) return NOT_ALLOWED(error.message);
    if (error instanceof TablesValidationError) return fail('INVALID_INPUT', error.message);
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run one app action for the session (see the module comment). */
export async function runSessionAction(
  context: Context,
  session: AppSession,
  located: LocatedCard,
  payload: Record<string, unknown>,
): Promise<PlatformActionResult> {
  const actionId = typeof payload.actionId === 'string' ? payload.actionId : '';
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
  if (!actionId) return fail('INVALID_INPUT', 'actionId is required');
  if (!APP_REQUEST_ID_PATTERN.test(requestId)) {
    return fail('INVALID_INPUT', 'requestId must be 8-100 letters, digits, _ or -');
  }
  const values = clientValues(payload.values);
  if (!values) return fail('INVALID_INPUT', 'values must be a list of {fieldId, value}');
  if (located.unavailable) return NOT_ALLOWED('This card is unavailable');
  const recordId =
    typeof payload.recordId === 'number' && Number.isInteger(payload.recordId) && payload.recordId > 0
      ? payload.recordId
      : undefined;
  const revision =
    typeof payload.revision === 'number' && Number.isInteger(payload.revision) && payload.revision > 0
      ? payload.revision
      : undefined;
  const buttonId = typeof payload.buttonId === 'string' && payload.buttonId ? payload.buttonId : undefined;
  const plan = planFor(session, located, actionId, buttonId);
  if (!isPlan(plan)) return plan;

  const ledger = {
    appId: session.app.id,
    userId: session.userId,
    requestId,
    actionId,
    pageId: located.page.id,
    cardId: located.card.id,
    recordId: recordId ?? null,
  };
  let claim = await context.db.tables.claimAppActionRequest(ledger);
  for (let waited = 0; !claim.claimed && claim.existing.status === 'running' && waited < REPLAY_WAIT_MS; ) {
    await sleep(REPLAY_POLL_MS);
    waited += REPLAY_POLL_MS;
    claim = await context.db.tables.claimAppActionRequest(ledger);
  }
  if (!claim.claimed) {
    if (claim.existing.status === 'done' && claim.existing.result) {
      return ok({ ...(claim.existing.result as unknown as AppActionResult), replayed: true });
    }
    return refuse('CONFLICT', 'conflict', 'The same request is still running');
  }

  const request: Request = {
    located,
    actionId,
    recordId,
    revision,
    values,
    requestId,
    timeZone: validTimeZone(payload.timezone),
  };
  let result: PlatformActionResult | undefined;
  try {
    result = await execute(context, session, request, plan);
    return result;
  } finally {
    if (result?.ok) {
      const data = result.data as AppActionResult;
      await context.db.tables.completeAppActionRequest(claim.id, {
        recordId: data.recordId,
        result: data as unknown as Record<string, unknown>,
      });
    } else {
      await context.db.tables.releaseAppActionRequest(claim.id);
    }
  }
}

/** Card kinds an action may target — the handler answers 400 for the rest before opening a ledger row. */
export function cardTakesActions(card: AppCard): boolean {
  return card.kind === 'form' || card.kind === 'buttons' || isRecordsCard(card);
}

const LEDGER_PRUNE_BATCH = 1000;

/**
 * Upkeep (hourly, with the app-upload sweep): drop action-ledger rows older
 * than the usage window (`APP_USAGE_WINDOW_DAYS`) — usage never reads them,
 * and the ledger would otherwise grow with every app write forever.
 */
export async function sweepAppActionLedger(db: DatabaseProvider, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - APP_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let removed = 0;
  for (let batch = 0; batch < 50; batch += 1) {
    const count = await db.tables.pruneAppActionRequests(before, LEDGER_PRUNE_BATCH);
    removed += count;
    if (count < LEDGER_PRUNE_BATCH) break;
  }
  return removed;
}
