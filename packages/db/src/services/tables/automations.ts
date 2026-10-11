/**
 * Automation rules: validation, storage, and the in-transaction enqueue.
 *
 * Nothing here executes a rule. A record write calls `enqueueAutomationEvents`
 * (through `onRecordWritten`, inside the write transaction): the rule's
 * condition is evaluated with THE SQL compiler on the before and after images,
 * and a matching rule becomes one `table_automation_outbox` row carrying the
 * rule revision and a snapshot of its actions. The API's automation worker
 * (`apps/api/src/platform/tables/automation-worker.ts`) claims those rows; the
 * sweep enqueues schedule / date rules and the button action enqueues clicks
 * (queue methods in `./automation-queue.ts`).
 *
 * Invariants:
 * - Action ids are stable: `checkAutomationConfig` keeps every id it is
 *   given and assigns `a<n>` (1-based position, bumped past collisions) only to
 *   actions without one — never an id the stored rule already uses, so a new
 *   action cannot inherit a deleted one's id — the delivery dedupe key, the
 *   resume cursor and webhook secrets are keyed by it. Migration 0024
 *   backfilled stored rules the same way.
 * - The executor (`execution_user_id`) is never input: it is whoever saved the
 *   rule's behaviour (create, or any change to trigger / config). The API
 *   requires that person to be builder+ at save and again before every run (D17).
 * - Webhook secrets live in `table_automation_secrets`, sealed by the caller's
 *   `sealer` with AAD `tables-automation:<ruleId>:<actionId>`; read paths return
 *   only `hasSecret`.
 */

import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import { fullTableAccess } from '@greenhouse/types/table-access';
import {
  automationTemplateFieldIds,
  automationTriggerHasActor,
  automationTriggerHasRecord,
  TABLE_AUTOMATION_LIMITS,
  TABLE_AUTOMATION_TRIGGERS,
  TABLE_AUTOMATION_VALUE_TOKENS,
  type TableAutomationAction,
  type TableAutomationActionInput,
  type TableAutomationConfig,
  type TableAutomationDateTrigger,
  type TableAutomationRecipients,
  type TableAutomationSchedule,
  type TableAutomationTrigger,
  type TableFieldType,
  type TableFieldValueEntry,
  type TableFilterGroup,
  type TableNotifyChannel,
  type TableRecordButton,
} from '@greenhouse/types/tables';
import type { Db } from '../../client.js';
import {
  tableAutomationOutbox,
  tableAutomationRules,
  tableAutomationRuns,
  tableAutomationSecrets,
  tableRecords,
  tableTables,
} from '../../schema/index.js';
import type {
  TableAutomationOutboxRow,
  TableAutomationRuleRow,
  TableAutomationRunRow,
  TableFieldRow,
} from '../../schema/tables.js';
import { diffRecordValues } from './activity.js';
import {
  compileFilterGroup,
  isValidTimeZone,
  loadCompileContext,
  validateFilterGroupShape,
  type TableCompileContext,
} from './query.js';
import { dbSchemaSource, sourceCompileContext, type TablesSchemaSource } from './schema-source.js';
import {
  isComputedField,
  isPlainObject,
  isPositiveInteger,
  MAX_QUERY_CLAUSES,
  TablesValidationError,
  trimmed,
  validateTableFieldValue,
  type TableRecordWrittenEvent,
  type TablesExecutor,
} from './shared.js';

/** What callers may send: action ids optional (assigned here), legacy shapes accepted. */
export type TableAutomationConfigInput = Omit<TableAutomationConfig, 'actions'> & {
  actions: TableAutomationActionInput[];
};

/** Seals a webhook secret for storage (the API's `encryptToken`); `aad` binds it to its rule and action. */
export interface AutomationSecretSealer {
  seal(plaintext: string, aad: string): string;
}

/** croner lives in the API: it tells the service when a schedule next fires. */
export interface AutomationScheduling {
  /** The first occurrence strictly after `after`, or null when the schedule never fires again. */
  nextOccurrence(schedule: TableAutomationSchedule, after: Date): Date | null;
  /** Default: now. */
  now?: Date;
}

export interface CreateTableAutomationInput {
  base_id: number;
  table_id: number;
  name: string;
  status?: 'disabled' | 'enabled';
  trigger: TableAutomationTrigger;
  config: TableAutomationConfigInput;
  /** The member saving the rule — and therefore its executor (D17). */
  user_id: string;
  /** Required for `schedule` rules. */
  scheduling?: AutomationScheduling;
  /** Required when a webhook action sets a secret (the UI route only). */
  sealer?: AutomationSecretSealer;
}

export interface UpdateTableAutomationInput {
  revision: number;
  name?: string;
  status?: 'disabled' | 'enabled';
  trigger?: TableAutomationTrigger;
  config?: TableAutomationConfigInput;
  /** The member saving; becomes the executor when trigger or config changes. */
  user_id: string;
  scheduling?: AutomationScheduling;
  sealer?: AutomationSecretSealer;
}

/** A rule as read paths return it: current config shape, webhooks carry `hasSecret`, never a secret. */
export type TableAutomationRuleView = TableAutomationRuleRow;

const ACTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const NOTIFY_CHANNELS: readonly TableNotifyChannel[] = ['inbox', 'im', 'email'];
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const TOKEN_FIELD_TYPES: Readonly<Record<string, readonly TableFieldType[]>> = {
  $now: ['datetime', 'date', 'text', 'long_text'],
  $today: ['date', 'text', 'long_text'],
  $actor: ['user', 'multi_user', 'text', 'long_text'],
};
const TEMPLATE_FIELD_TYPES: readonly TableFieldType[] = ['text', 'long_text', 'url', 'email', 'phone'];
const DATE_FIELD_TYPES: readonly TableFieldType[] = ['date', 'datetime'];

/** The AAD a webhook secret is sealed with: moved to another rule or action it fails to open. */
export function automationSecretAad(ruleId: number, actionId: string): string {
  return `tables-automation:${ruleId}:${actionId}`;
}

/**
 * Keep given ids, assign `a<n>` (1-based) to the rest, never two the same.
 * `reserved` ids (the stored rule's) are never handed to a new action: an id a
 * deleted action held would otherwise carry its webhook secret, delivery
 * dedupe key and resume cursor over to an unrelated action.
 */
export function assignAutomationActionIds(
  actions: ReadonlyArray<{ id?: unknown }>,
  reserved: Iterable<string> = [],
): string[] {
  const used = new Set<string>();
  for (const action of actions) {
    if (action.id === undefined) continue;
    if (typeof action.id !== 'string' || !ACTION_ID_PATTERN.test(action.id)) {
      throw new TablesValidationError('Automation action id must be 1-40 letters, digits, _ or -');
    }
    if (used.has(action.id)) throw new TablesValidationError(`Duplicate automation action id "${action.id}"`);
    used.add(action.id);
  }
  const taken = new Set([...used, ...reserved]);
  return actions.map((action, index) => {
    if (typeof action.id === 'string') return action.id;
    let next = index + 1;
    while (taken.has(`a${next}`)) next += 1;
    const id = `a${next}`;
    taken.add(id);
    return id;
  });
}

/** `[{fieldId, value}]`, or the legacy `{ "<fieldId>": value }` object. */
function normalizeValueEntries(raw: unknown, label: string): TableFieldValueEntry[] {
  let entries: TableFieldValueEntry[];
  if (Array.isArray(raw)) {
    entries = raw.map((entry) => {
      if (!isPlainObject(entry) || !isPositiveInteger(entry.fieldId)) {
        throw new TablesValidationError(`${label} values require a fieldId per entry`);
      }
      return { fieldId: entry.fieldId, value: entry.value === undefined ? null : entry.value };
    });
  } else if (isPlainObject(raw)) {
    entries = Object.entries(raw).map(([key, value]) => {
      if (!/^\d+$/.test(key) || Number(key) < 1) throw new TablesValidationError(`${label} has an invalid field id`);
      return { fieldId: Number(key), value: value === undefined ? null : value };
    });
  } else {
    throw new TablesValidationError(`${label} action requires values`);
  }
  if (entries.length < 1) throw new TablesValidationError(`${label} sets at least one field`);
  if (entries.length > 100) throw new TablesValidationError(`${label} supports at most 100 values`);
  if (new Set(entries.map((entry) => entry.fieldId)).size !== entries.length) {
    throw new TablesValidationError(`${label} sets the same field twice`);
  }
  return entries;
}

function uniqueList<T>(raw: unknown, label: string, max: number, valid: (value: unknown) => value is T): T[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > max || !raw.every(valid)) {
    throw new TablesValidationError(`${label} must be a list of at most ${max} valid ids`);
  }
  return [...new Set(raw)];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * The stored config in its current shape — a pure read-side normalization for
 * rows written before 0023 (object `values`, `notify {userIds}`) and any action
 * that still lacks an id. Never validates against the schema.
 */
export function normalizeStoredAutomationConfig(raw: unknown): TableAutomationConfig {
  const source = isPlainObject(raw) ? raw : {};
  const rawActions = Array.isArray(source.actions) ? source.actions.filter(isPlainObject) : [];
  let ids: string[];
  try {
    ids = assignAutomationActionIds(rawActions as Array<{ id?: unknown }>);
  } catch {
    // A corrupt id set: fall back to positions (the run snapshot still keys by them).
    ids = rawActions.map((_, index) => `a${index + 1}`);
  }
  const actions = rawActions.map((action, index): TableAutomationAction => {
    const id = ids[index]!;
    if (action.type === 'update_record' || action.type === 'create_record') {
      let values: TableFieldValueEntry[];
      try {
        values = normalizeValueEntries(action.values, String(action.type));
      } catch {
        values = [];
      }
      return action.type === 'update_record'
        ? { id, type: 'update_record', values }
        : { id, type: 'create_record', tableId: Number(action.tableId), values };
    }
    if (action.type === 'notify') {
      const recipients = isPlainObject(action.recipients)
        ? (action.recipients as TableAutomationRecipients)
        : Array.isArray(action.userIds)
          ? { userIds: action.userIds.filter((entry): entry is string => typeof entry === 'string') }
          : {};
      return {
        id,
        type: 'notify',
        recipients,
        title: String(action.title ?? ''),
        message: String(action.message ?? ''),
        ...(Array.isArray(action.channels) ? { channels: action.channels as TableNotifyChannel[] } : {}),
        ...(action.urgent === true ? { urgent: true } : {}),
      };
    }
    if (action.type === 'webhook') {
      return {
        id,
        type: 'webhook',
        url: String(action.url ?? ''),
        ...(Array.isArray(action.fieldIds) ? { fieldIds: action.fieldIds.filter(isPositiveInteger) } : {}),
      };
    }
    return { id, type: 'delay', minutes: Number(action.minutes) || 1 };
  });
  return { ...(source as unknown as TableAutomationConfig), actions };
}

/** The validation of one rule against the live schema (fields, users, groups). */
interface RuleContext {
  source: TablesSchemaSource;
  baseId: number;
  tableId: number;
  trigger: TableAutomationTrigger;
  fields: Map<number, TableFieldRow>;
  hasRecord: boolean;
  hasActor: boolean;
}

function fieldOf(context: RuleContext, fieldId: number, label: string): TableFieldRow {
  const field = context.fields.get(fieldId);
  if (!field) throw new TablesValidationError(`${label} references an unavailable field`);
  return field;
}

function assertTemplate(context: RuleContext, text: string, label: string): void {
  const ids = automationTemplateFieldIds(text);
  if (ids.length === 0) return;
  if (!context.hasRecord)
    throw new TablesValidationError(`${label} uses record fields, but this trigger has no record`);
  for (const id of ids) fieldOf(context, id, label);
}

/** Writes: active, non-computed fields; tokens and templates only where they fit; literals validated now. */
async function writableValues(
  context: RuleContext,
  targetTableId: number,
  entries: TableFieldValueEntry[],
  label: string,
): Promise<void> {
  const [fields, activeUserIds] = await Promise.all([
    context.source.fields(targetTableId),
    context.source.activeUserIds(),
  ]);
  const byId = new Map(fields.map((field) => [field.id, field]));
  for (const entry of entries) {
    const field = byId.get(entry.fieldId);
    if (!field) throw new TablesValidationError(`${label} references an unavailable field`);
    if (isComputedField(field)) throw new TablesValidationError(`${label} cannot write computed field "${field.name}"`);
    const value = entry.value;
    if (typeof value === 'string' && (TABLE_AUTOMATION_VALUE_TOKENS as readonly string[]).includes(value)) {
      if (!TOKEN_FIELD_TYPES[value]!.includes(field.type)) {
        throw new TablesValidationError(`${label}: ${value} does not fit field "${field.name}"`);
      }
      if (value === '$actor' && !context.hasActor) {
        throw new TablesValidationError(`${label}: $actor needs a trigger with a member behind it`);
      }
      continue;
    }
    if (typeof value === 'string' && automationTemplateFieldIds(value).length > 0) {
      if (!TEMPLATE_FIELD_TYPES.includes(field.type)) {
        throw new TablesValidationError(`${label}: field "${field.name}" cannot take a {{field}} template`);
      }
      assertTemplate(context, value, label);
      continue;
    }
    if (field.type === 'relation') continue; // targets are checked when the write runs
    validateTableFieldValue(field, value, activeUserIds);
  }
}

async function normalizeRecipients(
  context: RuleContext,
  raw: unknown,
  legacyUserIds: unknown,
): Promise<TableAutomationRecipients> {
  const source = isPlainObject(raw) ? raw : {};
  const userIds = uniqueList(source.userIds ?? legacyUserIds, 'notify userIds', 50, isNonEmptyString);
  const groupIds = uniqueList(source.groupIds, 'notify groupIds', 20, isPositiveInteger);
  const userFieldIds = uniqueList(source.userFieldIds, 'notify userFieldIds', 10, isPositiveInteger);
  const creator = source.creator === true;
  const actor = source.actor === true;
  if (userIds.length + groupIds.length + userFieldIds.length === 0 && !creator && !actor) {
    throw new TablesValidationError('notify action requires at least one recipient');
  }
  if ((userFieldIds.length > 0 || creator) && !context.hasRecord) {
    throw new TablesValidationError('notify recipients from the record need a trigger with a record');
  }
  if (actor && !context.hasActor) {
    throw new TablesValidationError('notify actor needs a trigger with a member behind it');
  }
  if (userIds.length > 0) {
    const active = await context.source.activeUserIds();
    if (userIds.some((id) => !active.has(id))) {
      throw new TablesValidationError('notify recipients must be active internal users');
    }
  }
  if (groupIds.length > 0) {
    const found = await context.source.existingGroupIds(groupIds);
    if (groupIds.some((id) => !found.has(id))) throw new TablesValidationError('notify groups must exist');
  }
  for (const fieldId of userFieldIds) {
    const field = fieldOf(context, fieldId, 'notify userFieldIds');
    if (field.type !== 'user' && field.type !== 'multi_user') {
      throw new TablesValidationError('notify userFieldIds must be person fields on this table');
    }
  }
  const recipients: TableAutomationRecipients = {
    ...(userIds.length > 0 ? { userIds } : {}),
    ...(groupIds.length > 0 ? { groupIds } : {}),
    ...(userFieldIds.length > 0 ? { userFieldIds } : {}),
    ...(creator ? { creator } : {}),
    ...(actor ? { actor } : {}),
  };
  return recipients;
}

function normalizeSchedule(raw: unknown): TableAutomationSchedule {
  if (!isPlainObject(raw)) throw new TablesValidationError('A schedule rule requires a schedule');
  const cron = typeof raw.cron === 'string' ? raw.cron.trim() : '';
  if (!cron || cron.length > 100) throw new TablesValidationError('Schedule requires a cron expression');
  const timezone = typeof raw.timezone === 'string' ? raw.timezone : '';
  if (!timezone || !isValidTimeZone(timezone)) throw new TablesValidationError('Schedule requires a valid time zone');
  if (raw.scope !== 'once' && raw.scope !== 'records') {
    throw new TablesValidationError('Schedule scope must be "once" or "records"');
  }
  return { cron, timezone, scope: raw.scope };
}

function normalizeDateTrigger(context: RuleContext, raw: unknown): TableAutomationDateTrigger {
  if (!isPlainObject(raw) || !isPositiveInteger(raw.fieldId)) {
    throw new TablesValidationError('A date rule requires a date field');
  }
  const field = fieldOf(context, raw.fieldId, 'Date trigger');
  if (!DATE_FIELD_TYPES.includes(field.type)) throw new TablesValidationError('Date trigger needs a date field');
  const offsetDays = raw.offsetDays ?? 0;
  if (
    typeof offsetDays !== 'number' ||
    !Number.isInteger(offsetDays) ||
    Math.abs(offsetDays) > TABLE_AUTOMATION_LIMITS.dateOffsetDays
  ) {
    throw new TablesValidationError(
      `Date trigger offset must be whole days within ±${TABLE_AUTOMATION_LIMITS.dateOffsetDays}`,
    );
  }
  const time = raw.time ?? '09:00';
  if (typeof time !== 'string' || !TIME_PATTERN.test(time))
    throw new TablesValidationError('Date trigger time is HH:MM');
  const timezone = typeof raw.timezone === 'string' ? raw.timezone : '';
  if (!timezone || !isValidTimeZone(timezone))
    throw new TablesValidationError('Date trigger requires a valid time zone');
  return { fieldId: field.id, offsetDays, time, timezone };
}

/**
 * Validate and normalize a rule config for its trigger. Accepts the legacy
 * shapes (object `values`, `notify {userIds}`) and returns the current one.
 * Keys that do not belong to the trigger are dropped; webhook secrets are
 * split off (`secrets`: action id → plaintext, or null = clear).
 */
export async function checkAutomationConfig(
  source: TablesSchemaSource,
  baseId: number,
  tableId: number,
  trigger: TableAutomationTrigger,
  input: TableAutomationConfigInput,
  options: { reservedActionIds?: Iterable<string> } = {},
): Promise<{ config: TableAutomationConfig; secrets: Map<string, string | null> }> {
  if (!(TABLE_AUTOMATION_TRIGGERS as readonly string[]).includes(trigger)) {
    throw new TablesValidationError('Unsupported automation trigger');
  }
  if (!isPlainObject(input) || !Array.isArray(input.actions)) {
    throw new TablesValidationError('Automation config requires actions');
  }
  if (input.actions.length < 1 || input.actions.length > TABLE_AUTOMATION_LIMITS.actions) {
    throw new TablesValidationError(`Automation supports 1-${TABLE_AUTOMATION_LIMITS.actions} actions`);
  }
  const schedule = trigger === 'schedule' ? normalizeSchedule(input.schedule) : undefined;
  const context: RuleContext = {
    baseId,
    tableId,
    trigger,
    source,
    fields: new Map((await source.fields(tableId)).map((field) => [field.id, field])),
    hasRecord: automationTriggerHasRecord(trigger, schedule),
    hasActor: automationTriggerHasActor(trigger),
  };

  let condition: TableFilterGroup | undefined;
  if (input.condition !== undefined && input.condition !== null) {
    validateFilterGroupShape(input.condition, 'Automation condition');
    if (input.condition.clauses.length > MAX_QUERY_CLAUSES) {
      throw new TablesValidationError(`Automation condition supports at most ${MAX_QUERY_CLAUSES} clauses`);
    }
    if (input.condition.clauses.some((clause) => clause.fieldId !== undefined && !context.fields.has(clause.fieldId))) {
      throw new TablesValidationError('Automation condition references an unavailable field');
    }
    // Compile once now so a malformed value is refused at save, not silently never matching.
    compileFilterGroup(input.condition, await sourceCompileContext(source, tableId, fullTableAccess(null)));
    if (input.condition.clauses.length > 0) condition = input.condition;
  }
  if (trigger === 'record_matched' && !condition) {
    throw new TablesValidationError('A "record matches" rule needs a condition');
  }
  if (trigger === 'schedule' && schedule?.scope === 'once' && condition) {
    throw new TablesValidationError('A condition needs a schedule that runs per record');
  }

  const watchFieldIds =
    trigger === 'record_updated' ? uniqueList(input.watchFieldIds, 'watchFieldIds', 20, isPositiveInteger) : [];
  for (const fieldId of watchFieldIds) fieldOf(context, fieldId, 'watchFieldIds');
  const dateTrigger = trigger === 'date_reached' ? normalizeDateTrigger(context, input.dateTrigger) : undefined;
  const buttonLabel =
    trigger === 'button'
      ? trimmed(input.buttonLabel as string, 'Button label', TABLE_AUTOMATION_LIMITS.buttonLabel)
      : undefined;

  const rawActions = input.actions as unknown[];
  if (!rawActions.every(isPlainObject)) throw new TablesValidationError('Each automation action must be an object');
  const ids = assignAutomationActionIds(rawActions as Array<{ id?: unknown }>, options.reservedActionIds);
  const actions: TableAutomationAction[] = [];
  const secrets = new Map<string, string | null>();
  for (const [index, raw] of (rawActions as Array<Record<string, unknown>>).entries()) {
    const id = ids[index]!;
    if (raw.type === 'update_record') {
      if (!context.hasRecord) throw new TablesValidationError('update_record needs a trigger with a record');
      const values = normalizeValueEntries(raw.values, 'update_record');
      await writableValues(context, tableId, values, 'update_record');
      actions.push({ id, type: 'update_record', values });
    } else if (raw.type === 'create_record') {
      const targetTableId = raw.tableId;
      const targetTable = isPositiveInteger(targetTableId) ? await source.table(targetTableId) : undefined;
      if (!targetTable || targetTable.base_id !== baseId || targetTable.archived) {
        throw new TablesValidationError('create_record target must be an active table in the same Base');
      }
      const values = normalizeValueEntries(raw.values, 'create_record');
      await writableValues(context, targetTable.id, values, 'create_record');
      actions.push({ id, type: 'create_record', tableId: targetTable.id, values });
    } else if (raw.type === 'notify') {
      const recipients = await normalizeRecipients(context, raw.recipients, raw.userIds);
      const channels = uniqueList(raw.channels, 'notify channels', 3, (value): value is TableNotifyChannel =>
        NOTIFY_CHANNELS.includes(value as TableNotifyChannel),
      );
      if (raw.urgent !== undefined && typeof raw.urgent !== 'boolean') {
        throw new TablesValidationError('notify urgent must be a boolean');
      }
      const title = trimmed(raw.title as string, 'Notification title', TABLE_AUTOMATION_LIMITS.notifyTitle);
      const message = trimmed(raw.message as string, 'Notification message', TABLE_AUTOMATION_LIMITS.notifyMessage);
      assertTemplate(context, title, 'Notification title');
      assertTemplate(context, message, 'Notification message');
      actions.push({
        id,
        type: 'notify',
        recipients,
        title,
        message,
        ...(channels.length > 0 ? { channels } : {}),
        ...(raw.urgent === true ? { urgent: true } : {}),
      });
    } else if (raw.type === 'webhook') {
      const url = typeof raw.url === 'string' ? raw.url.trim() : '';
      let parsed: URL | null;
      try {
        parsed = new URL(url);
      } catch {
        parsed = null;
      }
      if (
        !parsed ||
        url.length > TABLE_AUTOMATION_LIMITS.webhookUrl ||
        (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
        parsed.username ||
        parsed.password
      ) {
        throw new TablesValidationError('Webhook needs an http(s) URL without credentials');
      }
      const fieldIds = uniqueList(raw.fieldIds, 'webhook fieldIds', 100, isPositiveInteger);
      for (const fieldId of fieldIds) fieldOf(context, fieldId, 'webhook fieldIds');
      if (raw.secret !== undefined) {
        if (raw.secret === null) secrets.set(id, null);
        else if (
          typeof raw.secret === 'string' &&
          raw.secret.length >= TABLE_AUTOMATION_LIMITS.webhookSecretMin &&
          raw.secret.length <= TABLE_AUTOMATION_LIMITS.webhookSecretMax
        ) {
          secrets.set(id, raw.secret);
        } else {
          throw new TablesValidationError(
            `Webhook secret must be ${TABLE_AUTOMATION_LIMITS.webhookSecretMin}-${TABLE_AUTOMATION_LIMITS.webhookSecretMax} characters`,
          );
        }
      }
      actions.push({ id, type: 'webhook', url: parsed.toString(), ...(fieldIds.length > 0 ? { fieldIds } : {}) });
    } else if (raw.type === 'delay') {
      const minutes = raw.minutes;
      if (
        typeof minutes !== 'number' ||
        !Number.isInteger(minutes) ||
        minutes < 1 ||
        minutes > TABLE_AUTOMATION_LIMITS.delayMinutes
      ) {
        throw new TablesValidationError(`Delay must be 1-${TABLE_AUTOMATION_LIMITS.delayMinutes} whole minutes`);
      }
      actions.push({ id, type: 'delay', minutes });
    } else {
      throw new TablesValidationError('Unsupported automation action');
    }
  }
  const config: TableAutomationConfig = {
    version: 1,
    ...(condition ? { condition } : {}),
    ...(watchFieldIds.length > 0 ? { watchFieldIds } : {}),
    ...(schedule ? { schedule } : {}),
    ...(dateTrigger ? { dateTrigger } : {}),
    ...(buttonLabel ? { buttonLabel } : {}),
    actions,
  };
  return { config, secrets };
}

export function createTablesAutomations(db: Db) {
  /** next_fire_at / swept_until for a rule whose trigger config was just set (or that was just enabled). */
  const timing = (
    trigger: TableAutomationTrigger,
    config: TableAutomationConfig,
    scheduling: AutomationScheduling | undefined,
  ): { next_fire_at: string | null; swept_until: string | null } => {
    const now = scheduling?.now ?? new Date();
    if (trigger === 'schedule') {
      if (!scheduling || !config.schedule) throw new TablesValidationError('Schedule rules need a scheduler');
      const next = scheduling.nextOccurrence(config.schedule, now);
      return { next_fire_at: next ? next.toISOString() : null, swept_until: null };
    }
    if (trigger === 'date_reached') return { next_fire_at: null, swept_until: now.toISOString() };
    return { next_fire_at: null, swept_until: null };
  };

  const writeSecrets = async (
    executor: TablesExecutor,
    ruleId: number,
    secrets: Map<string, string | null>,
    sealer: AutomationSecretSealer | undefined,
  ): Promise<void> => {
    for (const [actionId, secret] of secrets) {
      if (secret === null) {
        await executor
          .delete(tableAutomationSecrets)
          .where(and(eq(tableAutomationSecrets.rule_id, ruleId), eq(tableAutomationSecrets.action_id, actionId)));
        continue;
      }
      if (!sealer) throw new TablesValidationError('Webhook secrets can only be set from the Tables editor');
      const ciphertext = sealer.seal(secret, automationSecretAad(ruleId, actionId));
      await executor
        .insert(tableAutomationSecrets)
        .values({ rule_id: ruleId, action_id: actionId, ciphertext, updated_at: nowIso() })
        .onConflictDoUpdate({
          target: [tableAutomationSecrets.rule_id, tableAutomationSecrets.action_id],
          set: { ciphertext, updated_at: nowIso() },
        });
    }
  };

  /** Read view: current shape, webhook actions marked `hasSecret`. */
  const decorate = async (rows: TableAutomationRuleRow[]): Promise<TableAutomationRuleView[]> => {
    if (rows.length === 0) return [];
    const stored = await db
      .select({ rule_id: tableAutomationSecrets.rule_id, action_id: tableAutomationSecrets.action_id })
      .from(tableAutomationSecrets)
      .where(
        inArray(
          tableAutomationSecrets.rule_id,
          rows.map((row) => row.id),
        ),
      );
    const withSecret = new Set(stored.map((row) => `${row.rule_id}:${row.action_id}`));
    return rows.map((row) => {
      const config = normalizeStoredAutomationConfig(row.config);
      return {
        ...row,
        config: {
          ...config,
          actions: config.actions.map((action) =>
            action.type === 'webhook' ? { ...action, hasSecret: withSecret.has(`${row.id}:${action.id}`) } : action,
          ),
        },
      };
    });
  };

  const getAutomationRule = async (id: number): Promise<TableAutomationRuleRow | undefined> => {
    const rows = await db.select().from(tableAutomationRules).where(eq(tableAutomationRules.id, id)).limit(1);
    return rows[0];
  };

  const service = {
    async listAutomationRules(baseId: number): Promise<TableAutomationRuleView[]> {
      return decorate(
        await db
          .select()
          .from(tableAutomationRules)
          .where(eq(tableAutomationRules.base_id, baseId))
          .orderBy(asc(tableAutomationRules.id)),
      );
    },

    /** The raw row (executor, revision, config as stored) — never return it to a client; use `getAutomationRuleView`. */
    getAutomationRule,

    async getAutomationRuleView(id: number): Promise<TableAutomationRuleView | undefined> {
      const row = await getAutomationRule(id);
      return row ? (await decorate([row]))[0] : undefined;
    },

    /** The sealed secret of one webhook action (the worker opens it with the same AAD). */
    async getAutomationSecret(ruleId: number, actionId: string): Promise<string | undefined> {
      const rows = await db
        .select({ ciphertext: tableAutomationSecrets.ciphertext })
        .from(tableAutomationSecrets)
        .where(and(eq(tableAutomationSecrets.rule_id, ruleId), eq(tableAutomationSecrets.action_id, actionId)))
        .limit(1);
      return rows[0]?.ciphertext;
    },

    async createAutomationRule(input: CreateTableAutomationInput): Promise<TableAutomationRuleView> {
      const [table] = await db.select().from(tableTables).where(eq(tableTables.id, input.table_id)).limit(1);
      if (!table || table.base_id !== input.base_id || table.archived_at) {
        throw new TablesValidationError('Automation table must belong to this Base');
      }
      const { config, secrets } = await checkAutomationConfig(
        dbSchemaSource(db),
        input.base_id,
        input.table_id,
        input.trigger,
        input.config,
      );
      const name = trimmed(input.name, 'Automation name', 120);
      const row = await db.transaction(async (tx) => {
        const now = nowIso();
        const [created] = await tx
          .insert(tableAutomationRules)
          .values({
            base_id: input.base_id,
            table_id: input.table_id,
            name,
            status: input.status ?? 'disabled',
            trigger: input.trigger,
            config,
            execution_user_id: input.user_id,
            revision: 1,
            ...timing(input.trigger, config, input.scheduling),
            created_by: input.user_id,
            updated_by: input.user_id,
            created_at: now,
            updated_at: now,
          })
          .returning();
        await writeSecrets(tx, created!.id, secrets, input.sealer);
        return created!;
      });
      return (await decorate([row]))[0]!;
    },

    async updateAutomationRule(
      id: number,
      patch: UpdateTableAutomationInput,
    ): Promise<
      { ok: true; value: TableAutomationRuleView } | { ok: false; reason: 'not_found' | 'conflict'; current?: number }
    > {
      const current = await getAutomationRule(id);
      if (!current) return { ok: false, reason: 'not_found' };
      if (current.revision !== patch.revision) {
        return { ok: false, reason: 'conflict', current: current.revision };
      }
      const trigger = patch.trigger ?? current.trigger;
      const triggerChanged = trigger !== current.trigger;
      const values: Partial<TableAutomationRuleRow> = {
        revision: patch.revision + 1,
        updated_by: patch.user_id,
        updated_at: nowIso(),
      };
      if (patch.name !== undefined) values.name = trimmed(patch.name, 'Automation name', 120);
      if (patch.status !== undefined) values.status = patch.status;
      let secrets = new Map<string, string | null>();
      let config = normalizeStoredAutomationConfig(current.config);
      const stored = config;
      if (patch.config !== undefined || triggerChanged) {
        const normalized = await checkAutomationConfig(
          dbSchemaSource(db),
          current.base_id,
          current.table_id,
          trigger,
          patch.config ?? (config as TableAutomationConfigInput),
          { reservedActionIds: stored.actions.map((action) => action.id) },
        );
        secrets = normalized.secrets;
        if (triggerChanged || !sameJson(normalized.config, config)) {
          // D17: whoever last changed what the rule does is who it runs as.
          values.execution_user_id = patch.user_id;
        }
        config = normalized.config;
        values.config = config;
        values.trigger = trigger;
        // Secrets of actions that no longer exist go with them.
        const kept = new Set(config.actions.filter((action) => action.type === 'webhook').map((action) => action.id));
        for (const action of stored.actions) {
          if (action.type === 'webhook' && !kept.has(action.id) && !secrets.has(action.id))
            secrets.set(action.id, null);
        }
      }
      const timingChanged =
        triggerChanged ||
        !sameJson(config.schedule, current.config.schedule) ||
        !sameJson(config.dateTrigger, current.config.dateTrigger);
      const enabled = current.status === 'disabled' && patch.status === 'enabled';
      if (timingChanged || enabled) Object.assign(values, timing(trigger, config, patch.scheduling));

      const row = await db.transaction(async (tx) => {
        const rows = await tx
          .update(tableAutomationRules)
          .set(values)
          .where(and(eq(tableAutomationRules.id, id), eq(tableAutomationRules.revision, patch.revision)))
          .returning();
        if (!rows[0]) return undefined;
        await writeSecrets(tx, id, secrets, patch.sealer);
        return rows[0];
      });
      if (row) return { ok: true, value: (await decorate([row]))[0]! };
      const latest = await getAutomationRule(id);
      return latest ? { ok: false, reason: 'conflict', current: latest.revision } : { ok: false, reason: 'not_found' };
    },

    /** Hard delete: runs, queued work and secrets go with the rule (FK cascade). */
    async deleteAutomationRule(id: number): Promise<boolean> {
      const rows = await db
        .delete(tableAutomationRules)
        .where(eq(tableAutomationRules.id, id))
        .returning({ id: tableAutomationRules.id });
      return rows.length > 0;
    },

    async listAutomationRuns(ruleId: number, limit = 50): Promise<TableAutomationRunRow[]> {
      return db
        .select()
        .from(tableAutomationRuns)
        .where(eq(tableAutomationRuns.rule_id, ruleId))
        .orderBy(desc(tableAutomationRuns.started_at), desc(tableAutomationRuns.id))
        .limit(Math.min(Math.max(limit, 1), 200));
    },

    /** Enabled button rules of a table whose condition holds for the record (`$me` = the viewer). */
    async listRecordButtons(tableId: number, recordId: number, viewerId: string): Promise<TableRecordButton[]> {
      const rules = await db
        .select()
        .from(tableAutomationRules)
        .where(
          and(
            eq(tableAutomationRules.table_id, tableId),
            eq(tableAutomationRules.status, 'enabled'),
            eq(tableAutomationRules.trigger, 'button'),
          ),
        )
        .orderBy(asc(tableAutomationRules.id));
      const buttons: TableRecordButton[] = [];
      for (const rule of rules) {
        if (await ruleConditionHolds(db, rule, recordId, viewerId)) {
          buttons.push({ ruleId: rule.id, label: rule.config.buttonLabel ?? rule.name });
        }
      }
      return buttons;
    },

    /**
     * Queue a button press. Idempotent per `requestId` (a double click is one
     * run); refuses a rule that is not an enabled button of this table, or whose
     * condition does not hold for the record now.
     */
    async enqueueButtonRun(input: {
      ruleId: number;
      tableId: number;
      recordId: number;
      actorId: string;
      requestId: string;
    }): Promise<{ ok: true; outbox: TableAutomationOutboxRow; duplicate: boolean } | { ok: false; reason: string }> {
      const rule = await getAutomationRule(input.ruleId);
      if (!rule || rule.table_id !== input.tableId || rule.trigger !== 'button' || rule.status !== 'enabled') {
        return { ok: false, reason: 'not_a_button' };
      }
      if (!(await ruleConditionHolds(db, rule, input.recordId, input.actorId))) {
        return { ok: false, reason: 'condition_not_met' };
      }
      const [record] = await db
        .select({ revision: tableRecords.revision })
        .from(tableRecords)
        .where(and(eq(tableRecords.id, input.recordId), isNull(tableRecords.deleted_at)))
        .limit(1);
      if (!record) return { ok: false, reason: 'record_unavailable' };
      const key = `rule:${rule.id}:button:${input.recordId}:${input.requestId}`;
      const created = await insertOutbox(db, rule, {
        recordId: input.recordId,
        trigger: 'button',
        key,
        payload: {
          tableId: rule.table_id,
          revision: record.revision,
          actorId: input.actorId,
          requestId: input.requestId,
        },
      });
      if (created) return { ok: true, outbox: created, duplicate: false };
      const [existing] = await db
        .select()
        .from(tableAutomationOutbox)
        .where(eq(tableAutomationOutbox.idempotency_key, key))
        .limit(1);
      return existing ? { ok: true, outbox: existing, duplicate: true } : { ok: false, reason: 'not_a_button' };
    },
  };

  return { service };
}

// ─── Enqueue (inside the record write transaction) ─────────

/** The evaluation zone of a rule's date tokens: its schedule / date trigger zone, else UTC. */
export function ruleTimeZone(config: TableAutomationConfig): string {
  return config.schedule?.timezone ?? config.dateTrigger?.timezone ?? 'UTC';
}

/**
 * Compile a rule's condition with THE compiler (`$me` = `actorId`, date tokens in
 * the rule's zone at `now`). Undefined = no condition; null = it cannot compile
 * any more (a field was archived) → the rule never matches.
 */
export async function compileRuleCondition(
  executor: TablesExecutor,
  rule: Pick<TableAutomationRuleRow, 'table_id' | 'config'>,
  actorId: string | null,
  now?: Date,
  /** Reuse one loaded context across the rules of a write (same table, same writer). */
  contexts?: Map<string, Promise<TableCompileContext>>,
): Promise<SQL | undefined | null> {
  const condition = rule.config.condition;
  if (!condition || condition.clauses.length === 0) return undefined;
  const timeZone = ruleTimeZone(rule.config);
  const load = () => loadCompileContext(executor, rule.table_id, fullTableAccess(actorId), { now, timeZone });
  let context: Promise<TableCompileContext>;
  if (contexts) {
    const key = `${rule.table_id}:${timeZone}`;
    if (!contexts.has(key)) contexts.set(key, load());
    context = contexts.get(key)!;
  } else {
    context = load();
  }
  try {
    return compileFilterGroup(condition, await context) ?? undefined;
  } catch (error) {
    // A condition on a field that has since been archived never matches.
    if (error instanceof TablesValidationError) return null;
    throw error;
  }
}

/** Does the compiled condition hold for the live row (as `executor` sees it)? */
async function holdsForRow(
  executor: TablesExecutor,
  condition: SQL | undefined,
  tableId: number,
  recordId: number,
): Promise<boolean> {
  const rows = await executor
    .select({ id: tableRecords.id })
    .from(tableRecords)
    .where(
      and(
        eq(tableRecords.id, recordId),
        eq(tableRecords.table_id, tableId),
        isNull(tableRecords.deleted_at),
        condition,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Does it hold for an earlier image of the row? The compiler references
 * `"table_records"."values"` etc., so the image is a one-row derived table under
 * that alias: the before values, the row's immutable creation columns, and the
 * updated_* columns as they were before the write.
 */
async function holdsForImage(
  executor: TablesExecutor,
  condition: SQL,
  recordId: number,
  image: { values: Record<string, unknown>; updatedAt?: string; updatedBy?: string },
): Promise<boolean> {
  const rows = await executor.execute(sql`
    SELECT 1 FROM (
      SELECT r.id, r.table_id,
        ${JSON.stringify(image.values)}::jsonb AS "values",
        '{}'::jsonb AS "computed_values",
        r.created_by, r.created_at,
        coalesce(${image.updatedBy ?? null}::text, r.updated_by) AS "updated_by",
        coalesce(${image.updatedAt ?? null}::timestamptz, r.updated_at) AS "updated_at",
        NULL::timestamptz AS "deleted_at"
      FROM ${tableRecords} r WHERE r.id = ${recordId}
    ) AS "table_records"
    WHERE ${condition}
    LIMIT 1`);
  return (rows as unknown as unknown[]).length > 0;
}

/** A rule's condition against the live record (`$me` = `actorId`). */
export async function ruleConditionHolds(
  executor: TablesExecutor,
  rule: Pick<TableAutomationRuleRow, 'table_id' | 'config'>,
  recordId: number,
  actorId: string | null,
): Promise<boolean> {
  const condition = await compileRuleCondition(executor, rule, actorId);
  if (condition === null) return false;
  return holdsForRow(executor, condition, rule.table_id, recordId);
}

/**
 * Insert one outbox row for a rule: the revision it was enqueued under, the
 * normalized action snapshot and the first action as the cursor. Undefined when
 * the idempotency key already exists.
 */
export async function insertOutbox(
  executor: TablesExecutor,
  rule: TableAutomationRuleRow,
  input: {
    recordId: number | null;
    trigger: TableAutomationTrigger;
    key: string;
    payload: Record<string, unknown>;
    scheduledFor?: string;
  },
): Promise<TableAutomationOutboxRow | undefined> {
  const actions = normalizeStoredAutomationConfig(rule.config).actions;
  const now = nowIso();
  const [row] = await executor
    .insert(tableAutomationOutbox)
    .values({
      rule_id: rule.id,
      record_id: input.recordId,
      event_type: input.trigger,
      trigger_kind: input.trigger,
      payload: input.payload,
      status: 'pending',
      idempotency_key: input.key,
      recursion_depth: 0,
      rule_revision: rule.revision,
      actions,
      cursor: actions[0]?.id ?? null,
      available_at: now,
      scheduled_for: input.scheduledFor ?? null,
      created_at: now,
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

/**
 * The in-transaction automation entry point for a record write (`onRecordWritten`).
 * Only creates and updates whose meta asks for it (imports and automations'
 * own writes do not — D6). Per enabled rule of the table:
 * - `record_created`: the condition holds after the write;
 * - `record_updated`: it holds after the write and a watched field changed
 *   (any field when none are watched);
 * - `record_matched`: it holds after the write and did not before (a new
 *   record "did not match" before it existed).
 * `$me` in a condition is the member whose write it is.
 */
export async function enqueueAutomationEvents(tx: TablesExecutor, event: TableRecordWrittenEvent): Promise<void> {
  if (!event.meta.enqueueAutomations) return;
  if (event.kind !== 'created' && event.kind !== 'updated') return;
  const triggers: TableAutomationTrigger[] =
    event.kind === 'created' ? ['record_created', 'record_matched'] : ['record_updated', 'record_matched'];
  const rules = await tx
    .select()
    .from(tableAutomationRules)
    .where(
      and(
        eq(tableAutomationRules.table_id, event.tableId),
        eq(tableAutomationRules.status, 'enabled'),
        inArray(tableAutomationRules.trigger, triggers),
      ),
    )
    .orderBy(asc(tableAutomationRules.id));
  if (rules.length === 0) return;
  const changed =
    event.kind === 'updated'
      ? new Set(diffRecordValues(event.before, event.after).map((change) => change.fieldId))
      : null;
  const contexts = new Map<string, Promise<TableCompileContext>>();

  for (const rule of rules) {
    if (rule.trigger === 'record_updated') {
      const watched = rule.config.watchFieldIds ?? [];
      const relevant = watched.length > 0 ? watched.some((fieldId) => changed?.has(fieldId)) : (changed?.size ?? 0) > 0;
      if (!relevant) continue;
    }
    const condition = await compileRuleCondition(tx, rule, event.meta.actorId, undefined, contexts);
    if (condition === null) continue;
    if (condition && !(await holdsForRow(tx, condition, event.tableId, event.recordId))) continue;
    if (rule.trigger === 'record_matched') {
      // No condition is refused at save; a dangling one never matches.
      if (!condition) continue;
      if (
        event.kind === 'updated' &&
        event.before &&
        (await holdsForImage(tx, condition, event.recordId, {
          values: event.before,
          updatedAt: event.previous?.updatedAt,
          updatedBy: event.previous?.updatedBy,
        }))
      ) {
        continue;
      }
    }
    await insertOutbox(tx, rule, {
      recordId: event.recordId,
      trigger: rule.trigger,
      key: `rule:${rule.id}:${rule.trigger}:${event.recordId}:${event.revision}`,
      payload: {
        tableId: event.tableId,
        revision: event.revision,
        actorId: event.meta.actorId,
        actorKind: event.meta.actorKind,
      },
    });
  }
}
