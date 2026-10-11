/**
 * The rule editor's working copy — pure, so the conversions and the checks the
 * editor runs before saving are tested without rendering.
 *
 * `ruleToDraft` turns a stored rule into a draft (values become field drafts
 * via `toFieldDraft`, a webhook's secret is never there — only `hasSecret`);
 * `draftToInput` turns it back into the create / update payload, or names the
 * first problem the server would refuse anyway. The server re-validates
 * everything; these checks only spare a round trip.
 */

import {
  automationTriggerHasActor,
  automationTriggerHasRecord,
  TABLE_AUTOMATION_LIMITS,
  type TableAutomationActionInput,
  type TableAutomationRecipients,
  type TableAutomationTrigger,
  type TableFieldType,
  type TableFilterGroup,
  type TableNotifyChannel,
} from '@greenhouse/types/tables';
import type { TableAutomation, TableAutomationConfigInput, TableField } from '../../../lib/api/tables';
import type { TranslationKey } from '../../../lib/i18n';
import { fromFieldDraft, toFieldDraft, type FieldDraft } from '../../../components/tables/field-draft';
import { completedFilterGroup } from '../../../components/tables/filter-model';
import { isComputedField } from '../../../components/tables/field-types';

export type ValueMode = 'value' | '$now' | '$today' | '$actor';

export interface ValueDraft {
  key: string;
  fieldId: number | null;
  mode: ValueMode;
  draft: FieldDraft;
}

export interface RecipientsDraft {
  userIds: string[];
  groupIds: number[];
  userFieldIds: number[];
  creator: boolean;
  actor: boolean;
}

export type ActionDraft =
  | { key: string; id?: string; type: 'update_record'; values: ValueDraft[] }
  | { key: string; id?: string; type: 'create_record'; tableId: number | null; values: ValueDraft[] }
  | {
      key: string;
      id?: string;
      type: 'notify';
      recipients: RecipientsDraft;
      title: string;
      message: string;
      im: boolean;
      email: boolean;
    }
  | {
      key: string;
      id?: string;
      type: 'webhook';
      url: string;
      fieldIds: number[];
      hasSecret: boolean;
      /** keep = leave the stored secret alone; set = `secret`; clear = remove it. */
      secretAction: 'keep' | 'set' | 'clear';
      secret: string;
    }
  | { key: string; id?: string; type: 'delay'; minutes: string };

export type ActionType = ActionDraft['type'];
export const ACTION_TYPES: readonly ActionType[] = ['update_record', 'create_record', 'notify', 'webhook', 'delay'];

export const ACTION_LABEL_KEYS = {
  update_record: 'tables.automations.action.update_record',
  create_record: 'tables.automations.action.create_record',
  notify: 'tables.automations.action.notify',
  webhook: 'tables.automations.action.webhook',
  delay: 'tables.automations.action.delay',
} as const satisfies Record<ActionType, TranslationKey>;

export const TRIGGER_LABEL_KEYS = {
  record_created: 'tables.automations.trigger.record_created',
  record_updated: 'tables.automations.trigger.record_updated',
  record_matched: 'tables.automations.trigger.record_matched',
  schedule: 'tables.automations.trigger.schedule',
  date_reached: 'tables.automations.trigger.date_reached',
  button: 'tables.automations.trigger.button',
} as const satisfies Record<TableAutomationTrigger, TranslationKey>;

export interface RuleDraft {
  name: string;
  tableId: number | null;
  trigger: TableAutomationTrigger;
  enabled: boolean;
  condition: TableFilterGroup;
  watchFieldIds: number[];
  cron: string;
  timezone: string;
  scope: 'once' | 'records';
  dateFieldId: number | null;
  offsetDays: string;
  time: string;
  buttonLabel: string;
  actions: ActionDraft[];
}

let keySeq = 0;
/** A local React key (never sent). */
export function draftKey(): string {
  keySeq += 1;
  return `d${keySeq}`;
}

/** Which whole-value tokens a field type accepts (mirrors the server's check). */
export const VALUE_MODE_FIELD_TYPES: Record<Exclude<ValueMode, 'value'>, readonly TableFieldType[]> = {
  $now: ['datetime', 'date', 'text', 'long_text'],
  $today: ['date', 'text', 'long_text'],
  $actor: ['user', 'multi_user', 'text', 'long_text'],
};

/** Field types whose text may carry `{{field:<id>}}`. */
export const TEMPLATE_FIELD_TYPES: readonly TableFieldType[] = ['text', 'long_text', 'url', 'email', 'phone'];

export function valueModesFor(field: TableField | undefined, trigger: TableAutomationTrigger): ValueMode[] {
  if (!field) return ['value'];
  return [
    'value',
    ...(['$now', '$today', '$actor'] as const).filter(
      (mode) =>
        VALUE_MODE_FIELD_TYPES[mode].includes(field.type) && (mode !== '$actor' || automationTriggerHasActor(trigger)),
    ),
  ];
}

/** Fields an action may write: active, not computed. */
export function writableFields(fields: readonly TableField[]): TableField[] {
  return fields.filter((field) => !isComputedField(field) && !field.archived_at);
}

export function emptyRecipients(): RecipientsDraft {
  return { userIds: [], groupIds: [], userFieldIds: [], creator: false, actor: false };
}

export function newActionDraft(type: ActionType, defaultTableId: number | null): ActionDraft {
  const key = draftKey();
  switch (type) {
    case 'update_record':
      return { key, type, values: [{ key: draftKey(), fieldId: null, mode: 'value', draft: '' }] };
    case 'create_record':
      return {
        key,
        type,
        tableId: defaultTableId,
        values: [{ key: draftKey(), fieldId: null, mode: 'value', draft: '' }],
      };
    case 'notify':
      return { key, type, recipients: emptyRecipients(), title: '', message: '', im: false, email: false };
    case 'webhook':
      return { key, type, url: '', fieldIds: [], hasSecret: false, secretAction: 'keep', secret: '' };
    case 'delay':
      return { key, type, minutes: '60' };
  }
}

export function newRuleDraft(input: { tableId: number | null; timezone: string }): RuleDraft {
  return {
    name: '',
    tableId: input.tableId,
    trigger: 'record_created',
    enabled: true,
    condition: { combinator: 'and', clauses: [] },
    watchFieldIds: [],
    cron: '0 9 * * 1-5',
    timezone: input.timezone,
    scope: 'once',
    dateFieldId: null,
    offsetDays: '0',
    time: '09:00',
    buttonLabel: '',
    actions: [newActionDraft('notify', input.tableId)],
  };
}

function valuesToDrafts(entries: ReadonlyArray<{ fieldId: number; value: unknown }>, fields: readonly TableField[]) {
  return entries.map((entry): ValueDraft => {
    const field = fields.find((candidate) => candidate.id === entry.fieldId);
    if (entry.value === '$now' || entry.value === '$today' || entry.value === '$actor') {
      return { key: draftKey(), fieldId: entry.fieldId, mode: entry.value, draft: '' };
    }
    return {
      key: draftKey(),
      fieldId: entry.fieldId,
      mode: 'value',
      draft: field ? toFieldDraft(field, entry.value) : String(entry.value ?? ''),
    };
  });
}

/** A stored rule → the editor's draft. `fieldsByTable` holds every table the rule writes to. */
export function ruleToDraft(
  rule: TableAutomation,
  fieldsByTable: ReadonlyMap<number, readonly TableField[]>,
  timezone: string,
): RuleDraft {
  const config = rule.config;
  const own = fieldsByTable.get(rule.table_id) ?? [];
  return {
    name: rule.name,
    tableId: rule.table_id,
    trigger: rule.trigger,
    enabled: rule.status === 'enabled',
    condition: config.condition ?? { combinator: 'and', clauses: [] },
    watchFieldIds: config.watchFieldIds ?? [],
    cron: config.schedule?.cron ?? '0 9 * * 1-5',
    timezone: config.schedule?.timezone ?? config.dateTrigger?.timezone ?? timezone,
    scope: config.schedule?.scope ?? 'once',
    dateFieldId: config.dateTrigger?.fieldId ?? null,
    offsetDays: String(config.dateTrigger?.offsetDays ?? 0),
    time: config.dateTrigger?.time ?? '09:00',
    buttonLabel: config.buttonLabel ?? '',
    actions: config.actions.map((action): ActionDraft => {
      switch (action.type) {
        case 'update_record':
          return { key: draftKey(), id: action.id, type: action.type, values: valuesToDrafts(action.values, own) };
        case 'create_record':
          return {
            key: draftKey(),
            id: action.id,
            type: action.type,
            tableId: action.tableId,
            values: valuesToDrafts(action.values, fieldsByTable.get(action.tableId) ?? []),
          };
        case 'notify':
          return {
            key: draftKey(),
            id: action.id,
            type: action.type,
            recipients: {
              userIds: action.recipients.userIds ?? [],
              groupIds: action.recipients.groupIds ?? [],
              userFieldIds: action.recipients.userFieldIds ?? [],
              creator: action.recipients.creator === true,
              actor: action.recipients.actor === true,
            },
            title: action.title,
            message: action.message,
            im: action.channels?.includes('im') ?? false,
            email: action.channels?.includes('email') ?? false,
          };
        case 'webhook':
          return {
            key: draftKey(),
            id: action.id,
            type: action.type,
            url: action.url,
            fieldIds: action.fieldIds ?? [],
            hasSecret: action.hasSecret === true,
            secretAction: 'keep',
            secret: '',
          };
        case 'delay':
          return { key: draftKey(), id: action.id, type: action.type, minutes: String(action.minutes) };
      }
    }),
  };
}

export type DraftProblem = { key: TranslationKey; step?: number };

export type DraftResult =
  | {
      ok: true;
      input: {
        name: string;
        tableId: number;
        trigger: TableAutomationTrigger;
        status: 'enabled' | 'disabled';
        config: TableAutomationConfigInput;
      };
    }
  | { ok: false; problem: DraftProblem };

function valuesToInput(values: readonly ValueDraft[], fields: readonly TableField[]) {
  const out: Array<{ fieldId: number; value: unknown }> = [];
  for (const value of values) {
    const field = fields.find((candidate) => candidate.id === value.fieldId);
    if (!field) return null;
    out.push({ fieldId: field.id, value: value.mode === 'value' ? fromFieldDraft(field, value.draft) : value.mode });
  }
  return out.length > 0 ? out : null;
}

function recipientsToInput(draft: RecipientsDraft, trigger: TableAutomationTrigger, hasRecord: boolean) {
  const recipients: TableAutomationRecipients = {
    ...(draft.userIds.length > 0 ? { userIds: draft.userIds } : {}),
    ...(draft.groupIds.length > 0 ? { groupIds: draft.groupIds } : {}),
    ...(hasRecord && draft.userFieldIds.length > 0 ? { userFieldIds: draft.userFieldIds } : {}),
    ...(hasRecord && draft.creator ? { creator: true } : {}),
    ...(automationTriggerHasActor(trigger) && draft.actor ? { actor: true } : {}),
  };
  return Object.keys(recipients).length > 0 ? recipients : null;
}

function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The draft as a create / update payload, or the first problem to show. */
export function draftToInput(draft: RuleDraft, fieldsByTable: ReadonlyMap<number, readonly TableField[]>): DraftResult {
  const fail = (key: TranslationKey, step?: number): DraftResult => ({ ok: false, problem: { key, step } });
  if (!draft.name.trim()) return fail('tables.automations.problem.name');
  if (draft.tableId === null) return fail('tables.automations.problem.table');
  const fields = fieldsByTable.get(draft.tableId) ?? [];
  const trigger = draft.trigger;
  const schedule =
    trigger === 'schedule'
      ? { cron: draft.cron.trim(), timezone: draft.timezone.trim(), scope: draft.scope }
      : undefined;
  if (schedule && (!schedule.cron || !schedule.timezone)) return fail('tables.automations.problem.schedule');
  const hasRecord = automationTriggerHasRecord(trigger, schedule);

  const completed = completedFilterGroup(draft.condition, [...fields]);
  if (completed.incompleteIndex !== null) return fail('tables.automations.problem.conditionIncomplete');
  const condition = hasRecord ? completed.group : undefined;
  if (trigger === 'record_matched' && !condition) return fail('tables.automations.problem.condition');

  let dateTrigger: TableAutomationConfigInput['dateTrigger'];
  if (trigger === 'date_reached') {
    if (draft.dateFieldId === null) return fail('tables.automations.problem.dateField');
    const offset = Number(draft.offsetDays);
    if (!Number.isInteger(offset) || Math.abs(offset) > TABLE_AUTOMATION_LIMITS.dateOffsetDays) {
      return fail('tables.automations.problem.dateOffset');
    }
    dateTrigger = { fieldId: draft.dateFieldId, offsetDays: offset, time: draft.time, timezone: draft.timezone.trim() };
  }
  if (trigger === 'button' && !draft.buttonLabel.trim()) return fail('tables.automations.problem.buttonLabel');
  if (draft.actions.length === 0) return fail('tables.automations.problem.noActions');

  const actions: TableAutomationActionInput[] = [];
  for (const [index, action] of draft.actions.entries()) {
    const step = index + 1;
    const id = action.id ? { id: action.id } : {};
    switch (action.type) {
      case 'update_record': {
        const values = valuesToInput(action.values, fields);
        if (!values) return fail('tables.automations.problem.values', step);
        actions.push({ ...id, type: 'update_record', values });
        break;
      }
      case 'create_record': {
        if (action.tableId === null) return fail('tables.automations.problem.targetTable', step);
        const values = valuesToInput(action.values, fieldsByTable.get(action.tableId) ?? []);
        if (!values) return fail('tables.automations.problem.values', step);
        actions.push({ ...id, type: 'create_record', tableId: action.tableId, values });
        break;
      }
      case 'notify': {
        const recipients = recipientsToInput(action.recipients, trigger, hasRecord);
        if (!recipients) return fail('tables.automations.problem.recipients', step);
        if (!action.title.trim() || !action.message.trim()) return fail('tables.automations.problem.notifyText', step);
        const channels: TableNotifyChannel[] = [
          'inbox',
          ...(action.im ? (['im'] as const) : []),
          ...(action.email ? (['email'] as const) : []),
        ];
        actions.push({
          ...id,
          type: 'notify',
          recipients,
          title: action.title.trim(),
          message: action.message.trim(),
          channels,
        });
        break;
      }
      case 'webhook': {
        if (!isHttpUrl(action.url)) return fail('tables.automations.problem.webhookUrl', step);
        let secret: { secret?: string | null } = {};
        if (action.secretAction === 'set') {
          const length = action.secret.length;
          if (length < TABLE_AUTOMATION_LIMITS.webhookSecretMin || length > TABLE_AUTOMATION_LIMITS.webhookSecretMax) {
            return fail('tables.automations.problem.secret', step);
          }
          secret = { secret: action.secret };
        } else if (action.secretAction === 'clear') {
          secret = { secret: null };
        }
        actions.push({
          ...id,
          type: 'webhook',
          url: action.url.trim(),
          ...(action.fieldIds.length > 0 ? { fieldIds: action.fieldIds } : {}),
          ...secret,
        });
        break;
      }
      case 'delay': {
        const minutes = Number(action.minutes);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > TABLE_AUTOMATION_LIMITS.delayMinutes) {
          return fail('tables.automations.problem.delay', step);
        }
        actions.push({ ...id, type: 'delay', minutes });
        break;
      }
    }
  }

  return {
    ok: true,
    input: {
      name: draft.name.trim(),
      tableId: draft.tableId,
      trigger,
      status: draft.enabled ? 'enabled' : 'disabled',
      config: {
        version: 1,
        ...(condition ? { condition } : {}),
        ...(trigger === 'record_updated' && draft.watchFieldIds.length > 0
          ? { watchFieldIds: draft.watchFieldIds }
          : {}),
        ...(schedule ? { schedule } : {}),
        ...(dateTrigger ? { dateTrigger } : {}),
        ...(trigger === 'button' ? { buttonLabel: draft.buttonLabel.trim() } : {}),
        actions,
      },
    },
  };
}
