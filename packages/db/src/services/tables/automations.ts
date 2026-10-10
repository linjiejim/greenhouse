/**
 * Automation rules, their runs, and the record-event entry points.
 *
 * Two execution paths exist during Phase 0:
 * - `enqueueAutomationEvents` — the final in-transaction entry point called by
 *   `onRecordWritten`. A no-op until slice Au implements the async outbox.
 * - `runLegacyAutomations` — the pre-0023 synchronous executor, run after the
 *   write commits. Kept working (on the new action shape) until Au replaces it;
 *   its outbox rows never set `rule_revision`, so the async worker never
 *   claims them.
 *
 * Action ids are stable: `normalizeAutomationConfig` keeps every id it is given
 * and assigns `a<n>` (1-based position, bumped past collisions) only to actions
 * without one — the delivery dedupe key, the resume cursor and webhook secrets
 * are keyed by it.
 */

import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import { fullTableAccess } from '@greenhouse/types/table-access';
import type {
  TableAutomationAction,
  TableAutomationActionInput,
  TableAutomationConfig,
  TableAutomationRecipients,
  TableAutomationRunStep,
  TableAutomationTrigger,
  TableFieldValueEntry,
  TableFilterGroup,
  TableNotifyChannel,
  TableRecordValues,
  TableRecordWriteMeta,
} from '@greenhouse/types/tables';
import type { Db } from '../../client.js';
import {
  groupMembers,
  tableAutomationOutbox,
  tableAutomationRules,
  tableAutomationRuns,
  tableFields,
  tableNotifications,
  tableRecords,
  tableTables,
  userGroups,
  users,
} from '../../schema/index.js';
import type {
  TableAutomationRuleRow,
  TableAutomationRunRow,
  TableFieldRow,
  TableNotificationRow,
  TableRecordRow,
} from '../../schema/tables.js';
import { compileFilterGroup, loadCompileContext, validateFilterGroupShape } from './query.js';
import type { TablesRecordInternals } from './records.js';
import {
  isComputedField,
  isPlainObject,
  isPositiveInteger,
  MAX_QUERY_CLAUSES,
  TablesValidationError,
  trimmed,
  type TableRecordWrittenEvent,
  type TablesExecutor,
} from './shared.js';

/** What callers may send: action ids optional (assigned here), legacy shapes accepted. */
export type TableAutomationConfigInput = Omit<TableAutomationConfig, 'actions'> & {
  actions: TableAutomationActionInput[];
};

export interface CreateTableAutomationInput {
  base_id: number;
  table_id: number;
  name: string;
  status?: 'disabled' | 'enabled';
  trigger: TableAutomationTrigger;
  config: TableAutomationConfigInput;
  execution_user_id: string;
  user_id: string;
}

export interface UpdateTableAutomationInput {
  revision: number;
  name?: string;
  status?: 'disabled' | 'enabled';
  trigger?: TableAutomationTrigger;
  config?: TableAutomationConfigInput;
  execution_user_id?: string;
  user_id: string;
}

/**
 * The in-transaction automation entry point for a record write (final
 * signature). Slice Au implements matching (SQL condition before / after),
 * outbox insertion and the async worker; until then automations still run
 * through the legacy executor after commit.
 */
export async function enqueueAutomationEvents(_tx: TablesExecutor, _event: TableRecordWrittenEvent): Promise<void> {
  // Intentionally empty in slice F.
}

const ACTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const NOTIFY_CHANNELS: readonly TableNotifyChannel[] = ['inbox', 'im', 'email'];

/** Keep given ids, assign `a<n>` (1-based) to the rest, never two the same. */
export function assignAutomationActionIds(actions: ReadonlyArray<{ id?: unknown }>): string[] {
  const used = new Set<string>();
  for (const action of actions) {
    if (action.id === undefined) continue;
    if (typeof action.id !== 'string' || !ACTION_ID_PATTERN.test(action.id)) {
      throw new TablesValidationError('Automation action id must be 1-40 letters, digits, _ or -');
    }
    if (used.has(action.id)) throw new TablesValidationError(`Duplicate automation action id "${action.id}"`);
    used.add(action.id);
  }
  return actions.map((action, index) => {
    if (typeof action.id === 'string') return action.id;
    let next = index + 1;
    while (used.has(`a${next}`)) next += 1;
    const id = `a${next}`;
    used.add(id);
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
  if (entries.length > 100) throw new TablesValidationError(`${label} supports at most 100 values`);
  if (new Set(entries.map((entry) => entry.fieldId)).size !== entries.length) {
    throw new TablesValidationError(`${label} sets the same field twice`);
  }
  return entries;
}

function entriesToValues(entries: TableFieldValueEntry[]): TableRecordValues {
  return Object.fromEntries(entries.map((entry) => [String(entry.fieldId), entry.value]));
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

export function createTablesAutomations(
  db: Db,
  deps: {
    records: TablesRecordInternals;
    canUserEditBase: (baseId: number, userId: string) => Promise<boolean>;
  },
) {
  const activeTableFields = (tableId: number): Promise<TableFieldRow[]> =>
    db
      .select()
      .from(tableFields)
      .where(and(eq(tableFields.table_id, tableId), isNull(tableFields.archived_at)));

  const writableFieldCheck = async (tableId: number, entries: TableFieldValueEntry[], label: string) => {
    if (entries.length === 0) return;
    const byId = new Map((await activeTableFields(tableId)).map((field) => [field.id, field]));
    for (const entry of entries) {
      const field = byId.get(entry.fieldId);
      if (!field) throw new TablesValidationError(`${label} references an unavailable field`);
      if (isComputedField(field))
        throw new TablesValidationError(`${label} cannot write computed field "${field.name}"`);
    }
  };

  const normalizeRecipients = async (
    tableId: number,
    raw: unknown,
    legacyUserIds: unknown,
  ): Promise<TableAutomationRecipients> => {
    const source = isPlainObject(raw) ? raw : {};
    const userIds = uniqueList(source.userIds ?? legacyUserIds, 'notify userIds', 50, isNonEmptyString);
    const groupIds = uniqueList(source.groupIds, 'notify groupIds', 20, isPositiveInteger);
    const userFieldIds = uniqueList(source.userFieldIds, 'notify userFieldIds', 10, isPositiveInteger);
    const creator = source.creator === true;
    const actor = source.actor === true;
    if (userIds.length + groupIds.length + userFieldIds.length === 0 && !creator && !actor) {
      throw new TablesValidationError('notify action requires at least one recipient');
    }
    if (userIds.length > 0) {
      const found = await db
        .select({ id: users.id })
        .from(users)
        .where(and(inArray(users.id, userIds), eq(users.status, 'active'), inArray(users.role, ['team', 'super'])));
      if (found.length !== userIds.length) {
        throw new TablesValidationError('notify recipients must be active internal users');
      }
    }
    if (groupIds.length > 0) {
      const found = await db.select({ id: userGroups.id }).from(userGroups).where(inArray(userGroups.id, groupIds));
      if (found.length !== groupIds.length) throw new TablesValidationError('notify groups must exist');
    }
    if (userFieldIds.length > 0) {
      const byId = new Map((await activeTableFields(tableId)).map((field) => [field.id, field]));
      if (userFieldIds.some((id) => !['user', 'multi_user'].includes(byId.get(id)?.type ?? ''))) {
        throw new TablesValidationError('notify userFieldIds must be person fields on this table');
      }
    }
    return {
      ...(userIds.length > 0 ? { userIds } : {}),
      ...(groupIds.length > 0 ? { groupIds } : {}),
      ...(userFieldIds.length > 0 ? { userFieldIds } : {}),
      ...(creator ? { creator } : {}),
      ...(actor ? { actor } : {}),
    };
  };

  /**
   * Validate and normalize a rule config. Accepts the legacy shapes (object
   * `values`, `notify {userIds}`) and returns the current one. Keys outside the
   * current contract are dropped; trigger-specific keys (`watchFieldIds`,
   * `schedule`, `dateTrigger`, `buttonLabel`) and the webhook / delay actions
   * arrive with slice Au.
   */
  const normalizeAutomationConfig = async (
    baseId: number,
    tableId: number,
    input: TableAutomationConfigInput,
  ): Promise<TableAutomationConfig> => {
    if (!isPlainObject(input) || !Array.isArray(input.actions)) {
      throw new TablesValidationError('Automation config requires actions');
    }
    if (input.actions.length < 1 || input.actions.length > 10) {
      throw new TablesValidationError('Automation supports 1-10 actions');
    }
    let condition: TableFilterGroup | undefined;
    if (input.condition !== undefined) {
      validateFilterGroupShape(input.condition, 'Automation condition');
      if (input.condition.clauses.length > MAX_QUERY_CLAUSES) {
        throw new TablesValidationError(`Automation condition supports at most ${MAX_QUERY_CLAUSES} clauses`);
      }
      const fieldIds = new Set((await activeTableFields(tableId)).map((field) => field.id));
      if (input.condition.clauses.some((clause) => clause.fieldId !== undefined && !fieldIds.has(clause.fieldId))) {
        throw new TablesValidationError('Automation condition references an unavailable field');
      }
      condition = input.condition;
    }
    const rawActions = input.actions as unknown[];
    if (!rawActions.every(isPlainObject)) throw new TablesValidationError('Each automation action must be an object');
    const ids = assignAutomationActionIds(rawActions as Array<{ id?: unknown }>);
    const actions: TableAutomationAction[] = [];
    for (const [index, raw] of (rawActions as Array<Record<string, unknown>>).entries()) {
      const id = ids[index]!;
      if (raw.type === 'update_record') {
        const values = normalizeValueEntries(raw.values, 'update_record');
        await writableFieldCheck(tableId, values, 'update_record');
        actions.push({ id, type: 'update_record', values });
      } else if (raw.type === 'create_record') {
        const targetTableId = raw.tableId;
        const [targetTable] = isPositiveInteger(targetTableId)
          ? await db.select().from(tableTables).where(eq(tableTables.id, targetTableId)).limit(1)
          : [];
        if (!targetTable || targetTable.base_id !== baseId || targetTable.archived_at) {
          throw new TablesValidationError('create_record target must be an active table in the same Base');
        }
        const values = normalizeValueEntries(raw.values, 'create_record');
        await writableFieldCheck(targetTable.id, values, 'create_record');
        actions.push({ id, type: 'create_record', tableId: targetTable.id, values });
      } else if (raw.type === 'notify') {
        const recipients = await normalizeRecipients(tableId, raw.recipients, raw.userIds);
        const channels = uniqueList(raw.channels, 'notify channels', 3, (value): value is TableNotifyChannel =>
          NOTIFY_CHANNELS.includes(value as TableNotifyChannel),
        );
        if (raw.urgent !== undefined && typeof raw.urgent !== 'boolean') {
          throw new TablesValidationError('notify urgent must be a boolean');
        }
        actions.push({
          id,
          type: 'notify',
          recipients,
          title: trimmed(raw.title as string, 'Notification title', 120),
          message: trimmed(raw.message as string, 'Notification message', 2_000),
          ...(channels.length > 0 ? { channels } : {}),
          ...(raw.urgent === true ? { urgent: true } : {}),
        });
      } else if (raw.type === 'webhook' || raw.type === 'delay') {
        throw new TablesValidationError(`Automation action "${raw.type}" is not supported yet`, 'not_supported');
      } else {
        throw new TablesValidationError('Unsupported automation action');
      }
    }
    return { version: 1, ...(condition ? { condition } : {}), actions };
  };

  const getAutomationRule = async (id: number): Promise<TableAutomationRuleRow | undefined> => {
    const rows = await db.select().from(tableAutomationRules).where(eq(tableAutomationRules.id, id)).limit(1);
    return rows[0];
  };

  /** Does the rule's condition hold for this (committed) record? One SQL compiler, `$me` = the writer. */
  const conditionMatches = async (
    rule: TableAutomationRuleRow,
    record: TableRecordRow,
    actorId: string,
  ): Promise<boolean> => {
    const condition = rule.config.condition;
    if (!condition || condition.clauses.length === 0) return true;
    let compiled;
    try {
      compiled = compileFilterGroup(condition, await loadCompileContext(db, record.table_id, fullTableAccess(actorId)));
    } catch (error) {
      // A condition on a field that has since been archived never matches.
      if (error instanceof TablesValidationError) return false;
      throw error;
    }
    if (!compiled) return true;
    const rows = await db
      .select({ id: tableRecords.id })
      .from(tableRecords)
      .where(and(eq(tableRecords.id, record.id), compiled))
      .limit(1);
    return rows.length > 0;
  };

  /** Recipients of a notify action for one record, as active internal user ids. */
  const resolveRecipients = async (
    recipients: TableAutomationRecipients,
    record: TableRecordRow,
    actorId: string,
  ): Promise<string[]> => {
    const ids = new Set<string>(recipients.userIds ?? []);
    if (recipients.creator) ids.add(record.created_by);
    if (recipients.actor) ids.add(actorId);
    const values = { ...record.values, ...record.computed_values };
    for (const fieldId of recipients.userFieldIds ?? []) {
      const value = values[String(fieldId)];
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (typeof entry === 'string' && entry) ids.add(entry);
      }
    }
    if (recipients.groupIds && recipients.groupIds.length > 0) {
      const members = await db
        .select({ user_id: groupMembers.user_id })
        .from(groupMembers)
        .where(inArray(groupMembers.group_id, recipients.groupIds));
      members.forEach((member) => ids.add(member.user_id));
    }
    if (ids.size === 0) return [];
    const active = await db
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, [...ids]), eq(users.status, 'active'), inArray(users.role, ['team', 'super'])));
    return active.map((row) => row.id).sort();
  };

  /**
   * The pre-0023 synchronous executor, after the triggering write commits.
   * Its own writes carry `actorKind: 'automation'` and never enqueue
   * automations (no chaining).
   */
  const runLegacyAutomations = async (
    eventType: 'record_created' | 'record_updated',
    record: TableRecordRow,
    meta: TableRecordWriteMeta,
  ): Promise<void> => {
    const rules = await db
      .select()
      .from(tableAutomationRules)
      .where(
        and(
          eq(tableAutomationRules.table_id, record.table_id),
          eq(tableAutomationRules.status, 'enabled'),
          eq(tableAutomationRules.trigger, eventType),
        ),
      )
      .orderBy(asc(tableAutomationRules.id));
    for (const rule of rules) {
      if (!(await conditionMatches(rule, record, meta.actorId))) continue;
      const now = nowIso();
      const [outbox] = await db
        .insert(tableAutomationOutbox)
        .values({
          rule_id: rule.id,
          record_id: record.id,
          event_type: eventType,
          trigger_kind: eventType,
          payload: { tableId: record.table_id, revision: record.revision },
          status: 'pending',
          idempotency_key: `rule:${rule.id}:${eventType}:${record.id}:${record.revision}`,
          recursion_depth: 0,
          created_at: now,
        })
        .onConflictDoNothing()
        .returning();
      if (!outbox) continue;
      const [run] = await db
        .insert(tableAutomationRuns)
        .values({
          rule_id: rule.id,
          outbox_id: outbox.id,
          status: 'running',
          actions_completed: 0,
          trigger_kind: eventType,
          record_id: record.id,
          started_at: now,
        })
        .returning();
      await db
        .update(tableAutomationOutbox)
        .set({ status: 'processing' })
        .where(eq(tableAutomationOutbox.id, outbox.id));
      const executor = rule.execution_user_id;
      const writeMeta: TableRecordWriteMeta = {
        actorId: executor,
        actorKind: 'automation',
        source: { ruleId: rule.id, executorId: executor },
        enqueueAutomations: false,
      };
      const steps: TableAutomationRunStep[] = [];
      let actionsCompleted = 0;
      try {
        if (!(await deps.canUserEditBase(rule.base_id, executor))) {
          throw new TablesValidationError('Automation execution user is inactive or lacks Base edit access');
        }
        for (const action of rule.config.actions) {
          if (action.type === 'notify') {
            const recipientIds = await resolveRecipients(action.recipients, record, meta.actorId);
            if (recipientIds.length > 0) {
              await db.insert(tableNotifications).values(
                recipientIds.map((userId) => ({
                  base_id: rule.base_id,
                  user_id: userId,
                  rule_id: rule.id,
                  record_id: record.id,
                  title: action.title,
                  message: action.message,
                  created_at: nowIso(),
                })),
              );
            }
            steps.push({
              actionId: action.id,
              type: action.type,
              status: 'succeeded',
              message: `${recipientIds.length} recipient(s)`,
              at: nowIso(),
            });
          } else if (action.type === 'update_record') {
            const [current] = await db
              .select()
              .from(tableRecords)
              .where(and(eq(tableRecords.id, record.id), isNull(tableRecords.deleted_at)))
              .limit(1);
            if (!current) throw new TablesValidationError('Automation record is unavailable');
            const result = await deps.records.updateRecordWithContext(
              {
                table_id: current.table_id,
                record_id: current.id,
                revision: current.revision,
                values: entriesToValues(action.values),
              },
              await deps.records.loadValidationContext(current.table_id),
              fullTableAccess(executor),
              writeMeta,
            );
            if (!result.ok) throw new TablesValidationError(`Automation update failed: ${result.reason}`);
            steps.push({ actionId: action.id, type: action.type, status: 'succeeded', at: nowIso() });
          } else if (action.type === 'create_record') {
            await deps.records.createRecordWithContext(
              { table_id: action.tableId, values: entriesToValues(action.values) },
              await deps.records.loadValidationContext(action.tableId),
              fullTableAccess(executor),
              writeMeta,
            );
            steps.push({ actionId: action.id, type: action.type, status: 'succeeded', at: nowIso() });
          } else {
            throw new TablesValidationError(`Automation action "${action.type}" is not supported yet`, 'not_supported');
          }
          actionsCompleted += 1;
        }
        await Promise.all([
          db
            .update(tableAutomationOutbox)
            .set({ status: 'succeeded', processed_at: nowIso() })
            .where(eq(tableAutomationOutbox.id, outbox.id)),
          db
            .update(tableAutomationRuns)
            .set({ status: 'succeeded', actions_completed: actionsCompleted, steps, finished_at: nowIso() })
            .where(eq(tableAutomationRuns.id, run!.id)),
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 2_000) : 'Unknown automation error';
        const failedAction = rule.config.actions[actionsCompleted];
        if (failedAction) {
          steps.push({ actionId: failedAction.id, type: failedAction.type, status: 'failed', message, at: nowIso() });
        }
        await Promise.all([
          db
            .update(tableAutomationOutbox)
            .set({ status: 'failed', last_error: message, processed_at: nowIso() })
            .where(eq(tableAutomationOutbox.id, outbox.id)),
          db
            .update(tableAutomationRuns)
            .set({
              status: 'failed',
              actions_completed: actionsCompleted,
              steps,
              error: message,
              finished_at: nowIso(),
            })
            .where(eq(tableAutomationRuns.id, run!.id)),
        ]);
      }
    }
  };

  const service = {
    async listAutomationRules(baseId: number): Promise<TableAutomationRuleRow[]> {
      return db
        .select()
        .from(tableAutomationRules)
        .where(eq(tableAutomationRules.base_id, baseId))
        .orderBy(asc(tableAutomationRules.id));
    },

    getAutomationRule,

    async createAutomationRule(input: CreateTableAutomationInput): Promise<TableAutomationRuleRow> {
      if (!['record_created', 'record_updated'].includes(input.trigger)) {
        throw new TablesValidationError('Unsupported automation trigger');
      }
      const [table] = await db.select().from(tableTables).where(eq(tableTables.id, input.table_id)).limit(1);
      if (!table || table.base_id !== input.base_id || table.archived_at) {
        throw new TablesValidationError('Automation table must belong to this Base');
      }
      if (!(await deps.canUserEditBase(input.base_id, input.execution_user_id))) {
        throw new TablesValidationError('Automation execution user must have Base edit access');
      }
      const config = await normalizeAutomationConfig(input.base_id, input.table_id, input.config);
      const now = nowIso();
      const [row] = await db
        .insert(tableAutomationRules)
        .values({
          base_id: input.base_id,
          table_id: input.table_id,
          name: trimmed(input.name, 'Automation name', 120),
          status: input.status ?? 'disabled',
          trigger: input.trigger,
          config,
          execution_user_id: input.execution_user_id,
          revision: 1,
          created_by: input.user_id,
          updated_by: input.user_id,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row!;
    },

    async updateAutomationRule(
      id: number,
      patch: UpdateTableAutomationInput,
    ): Promise<
      { ok: true; value: TableAutomationRuleRow } | { ok: false; reason: 'not_found' | 'conflict'; current?: number }
    > {
      const current = await getAutomationRule(id);
      if (!current) return { ok: false, reason: 'not_found' };
      if (current.revision !== patch.revision) {
        return { ok: false, reason: 'conflict', current: current.revision };
      }
      const executionUserId = patch.execution_user_id ?? current.execution_user_id;
      if (!(await deps.canUserEditBase(current.base_id, executionUserId))) {
        throw new TablesValidationError('Automation execution user must have Base edit access');
      }
      const values: Partial<TableAutomationRuleRow> = {
        revision: patch.revision + 1,
        updated_by: patch.user_id,
        updated_at: nowIso(),
      };
      if (patch.name !== undefined) values.name = trimmed(patch.name, 'Automation name', 120);
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.trigger !== undefined) values.trigger = patch.trigger;
      if (patch.execution_user_id !== undefined) values.execution_user_id = patch.execution_user_id;
      if (patch.config !== undefined) {
        values.config = await normalizeAutomationConfig(current.base_id, current.table_id, patch.config);
      }
      const rows = await db
        .update(tableAutomationRules)
        .set(values)
        .where(and(eq(tableAutomationRules.id, id), eq(tableAutomationRules.revision, patch.revision)))
        .returning();
      if (rows[0]) return { ok: true, value: rows[0] };
      const latest = await getAutomationRule(id);
      return latest ? { ok: false, reason: 'conflict', current: latest.revision } : { ok: false, reason: 'not_found' };
    },

    async listAutomationRuns(ruleId: number, limit = 50): Promise<TableAutomationRunRow[]> {
      return db
        .select()
        .from(tableAutomationRuns)
        .where(eq(tableAutomationRuns.rule_id, ruleId))
        .orderBy(desc(tableAutomationRuns.started_at))
        .limit(Math.min(Math.max(limit, 1), 200));
    },

    /** Legacy inbox (`table_notifications`), kept until the next release — see db AGENTS.md. */
    async listNotifications(userId: string, limit = 100): Promise<TableNotificationRow[]> {
      return db
        .select()
        .from(tableNotifications)
        .where(eq(tableNotifications.user_id, userId))
        .orderBy(desc(tableNotifications.created_at))
        .limit(Math.min(Math.max(limit, 1), 200));
    },

    async markNotificationRead(id: number, userId: string): Promise<TableNotificationRow | undefined> {
      const rows = await db
        .update(tableNotifications)
        .set({ read_at: nowIso() })
        .where(and(eq(tableNotifications.id, id), eq(tableNotifications.user_id, userId)))
        .returning();
      return rows[0];
    },
  };

  return { service, runLegacyAutomations };
}
