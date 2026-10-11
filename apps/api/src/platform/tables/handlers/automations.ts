/**
 * Automation rules, runs and record buttons.
 *
 * - Rules are builder work (`requireBase(…, 'builder')`). The executor is never
 *   input: the saver of the rule's behaviour runs it (D17) — a payload or plan
 *   op naming `executionUserId` is refused — and the worker re-checks that the
 *   executor is still builder+ before every run.
 * - Webhooks are UI-only (D16): only a person (not a delegated agent) may add a
 *   webhook action or set its secret; secrets are sealed here with the instance
 *   key (AAD `tables-automation:<ruleId>:<actionId>`) and never read back — read
 *   paths carry only `hasSecret`.
 * - Notify groups follow D12: a saver may name only groups they can see.
 * - Buttons: `listRecordButtons` / `triggerAutomation` need update rights on the
 *   row (built-in editor+, or a custom role's edit rows); pressing only queues a
 *   run (idempotent per `requestId`) — the worker runs it.
 */

import { effectiveUserId, type ActorContext } from '@greenhouse/platform-kernel';
import type { AutomationSecretSealer, TableAutomationConfigInput, TableAutomationRuleRow } from '@greenhouse/db';
import { normalizeStoredAutomationConfig } from '@greenhouse/db';
import { TABLE_AUTOMATION_TRIGGERS, type TableAutomationTrigger } from '@greenhouse/types/tables';
import { encryptToken, isEncryptionConfigured } from '../../../auth/crypto.js';
import { assertSafeWebhookUrl } from '../../../security/network.js';
import { baseForAutomation, baseForTable, requireBase, requireTableData, type TableDataAccess } from '../access.js';
import { tablesScheduling, validateTablesSchedule } from '../automation-schedule.js';
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
import type { PlatformHandlerContext } from '../../runtime.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

function triggerValue(payload: Record<string, unknown>): TableAutomationTrigger | undefined {
  const value = payload.trigger;
  return typeof value === 'string' && (TABLE_AUTOMATION_TRIGGERS as readonly string[]).includes(value)
    ? (value as TableAutomationTrigger)
    : undefined;
}

type RawAction = Record<string, unknown>;

function rawActions(config: TableAutomationConfigInput | undefined): RawAction[] {
  return Array.isArray(config?.actions)
    ? (config.actions as unknown[]).filter((action): action is RawAction => !!action && typeof action === 'object')
    : [];
}

/**
 * The API-side checks of a config the db cannot make: webhook targets on the
 * public internet and only from a person, secrets only from a person (and only
 * with the instance key configured), a schedule croner accepts, notify groups
 * the saver can see. `current` is the stored rule on update (its webhooks and
 * groups were already accepted). Returns a failure, or the sealer to pass on.
 */
async function vetConfig(
  context: PlatformHandlerContext,
  actor: ActorContext,
  trigger: TableAutomationTrigger,
  config: TableAutomationConfigInput | undefined,
  current?: TableAutomationRuleRow,
): Promise<{ error: ReturnType<typeof fail> } | { sealer?: AutomationSecretSealer }> {
  if (!config) return {};
  const person = actor.actorType === 'human';
  const before = current ? normalizeStoredAutomationConfig(current.config) : undefined;
  const knownWebhooks = new Set(
    (before?.actions ?? []).filter((action) => action.type === 'webhook').map((action) => `${action.id}|${action.url}`),
  );
  let needsSealer = false;
  for (const action of rawActions(config)) {
    if (action.type !== 'webhook') continue;
    const url = typeof action.url === 'string' ? action.url.trim() : '';
    if (!knownWebhooks.has(`${String(action.id)}|${url}`) && !person) {
      return {
        error: fail('FORBIDDEN', 'Webhooks can only be added in the Tables editor', { reason: 'webhook_ui_only' }),
      };
    }
    try {
      assertSafeWebhookUrl(url);
    } catch (error) {
      return { error: fail('INVALID_INPUT', (error as Error).message) };
    }
    if (typeof action.secret === 'string') {
      if (!person) {
        return {
          error: fail('FORBIDDEN', 'Webhook secrets can only be set in the Tables editor', {
            reason: 'webhook_ui_only',
          }),
        };
      }
      if (!isEncryptionConfigured()) {
        return {
          error: fail('INVALID_INPUT', 'Webhook secrets need PROVIDER_TOKEN_ENCRYPTION_KEY on this deployment'),
        };
      }
      needsSealer = true;
    }
  }
  if (trigger === 'schedule') {
    const schedule = config.schedule;
    const problem = schedule ? validateTablesSchedule(schedule) : 'A schedule rule requires a schedule';
    if (problem) return { error: fail('INVALID_INPUT', problem) };
  }
  const known = new Set(
    (before?.actions ?? []).flatMap((action) => (action.type === 'notify' ? (action.recipients.groupIds ?? []) : [])),
  );
  const named = rawActions(config).flatMap((action) =>
    action.type === 'notify' && action.recipients && typeof action.recipients === 'object'
      ? (((action.recipients as { groupIds?: unknown }).groupIds as unknown[] | undefined) ?? [])
      : [],
  );
  const added = named.filter((id): id is number => typeof id === 'number' && !known.has(id));
  if (added.length > 0) {
    const userId = effectiveUserId(actor);
    const user = await context.db.users.getById(userId);
    if (user?.role !== 'super') {
      const visible = new Set((await context.db.groups.listForUser(userId)).map((group) => group.id));
      if (added.some((id) => !visible.has(id))) return { error: fail('NOT_FOUND', 'Group not found') };
    }
  }
  return needsSealer ? { sealer: { seal: (plaintext, aad) => encryptToken(plaintext, aad) } } : {};
}

function refuseExecutor(payload: Record<string, unknown>) {
  return 'executionUserId' in payload || 'execution_user_id' in payload
    ? fail('INVALID_INPUT', 'The executor is whoever saves the rule; it cannot be chosen')
    : null;
}

const listAutomations: Handler = async (request, context) => {
  const baseId = positiveInt(payloadOf(request), 'baseId');
  if (!baseId) return fail('INVALID_INPUT', 'baseId is required');
  if (!(await requireBase(context, request.actor, baseId, 'automation', 'builder'))) {
    return fail('NOT_FOUND', 'Base not found');
  }
  return ok({ automations: await context.db.tables.listAutomationRules(baseId) });
};

const createAutomation: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const refused = refuseExecutor(payload);
  if (refused) return refused;
  const baseId = positiveInt(payload, 'baseId');
  const tableId = positiveInt(payload, 'tableId');
  const name = stringValue(payload, 'name');
  const trigger = triggerValue(payload);
  const config = objectValue<TableAutomationConfigInput>(payload, 'config');
  if (!baseId || !tableId || !name || !trigger || !config) {
    return fail('INVALID_INPUT', 'baseId, tableId, name, trigger, and config are required');
  }
  if (!(await requireBase(context, request.actor, baseId, 'automation', 'builder'))) {
    return fail('NOT_FOUND', 'Base not found');
  }
  const vetted = await vetConfig(context, request.actor, trigger, config);
  if ('error' in vetted) return vetted.error;
  const automation = await context.db.tables.createAutomationRule({
    base_id: baseId,
    table_id: tableId,
    name,
    status: payload.status === 'enabled' ? 'enabled' : 'disabled',
    trigger,
    config,
    user_id: effectiveUserId(request.actor),
    scheduling: tablesScheduling(),
    sealer: vetted.sealer,
  });
  return ok({ automation });
};

const updateAutomation: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const refused = refuseExecutor(payload);
  if (refused) return refused;
  const automationId = positiveInt(payload, 'automationId');
  const revision = positiveInt(payload, 'revision');
  if (!automationId || !revision) return fail('INVALID_INPUT', 'automationId and revision are required');
  if (payload.trigger !== undefined && !triggerValue(payload))
    return fail('INVALID_INPUT', 'Unsupported automation trigger');
  const base = await baseForAutomation(context.db, automationId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'automation', 'builder'))) {
    return fail('NOT_FOUND', 'Automation not found');
  }
  const current = (await context.db.tables.getAutomationRule(automationId))!;
  const trigger = triggerValue(payload) ?? current.trigger;
  const config = objectValue<TableAutomationConfigInput>(payload, 'config');
  const vetted = await vetConfig(context, request.actor, trigger, config, current);
  if ('error' in vetted) return vetted.error;
  const result = await context.db.tables.updateAutomationRule(automationId, {
    revision,
    name: stringValue(payload, 'name'),
    status: payload.status === 'enabled' || payload.status === 'disabled' ? payload.status : undefined,
    trigger: triggerValue(payload),
    config,
    user_id: effectiveUserId(request.actor),
    scheduling: tablesScheduling(),
    sealer: vetted.sealer,
  });
  if (result.ok) return ok({ automation: result.value });
  return result.reason === 'conflict'
    ? fail('CONFLICT', 'Automation revision conflict', { currentRevision: result.current })
    : fail('NOT_FOUND', 'Automation not found');
};

const deleteAutomation: Handler = async (request, context) => {
  const automationId = positiveInt(payloadOf(request), 'automationId');
  if (!automationId) return fail('INVALID_INPUT', 'automationId is required');
  const base = await baseForAutomation(context.db, automationId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'automation', 'builder'))) {
    return fail('NOT_FOUND', 'Automation not found');
  }
  if (!(await context.db.tables.deleteAutomationRule(automationId))) return fail('NOT_FOUND', 'Automation not found');
  return ok({ deleted: true });
};

const listAutomationRuns: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const automationId = positiveInt(payload, 'automationId');
  if (!automationId) return fail('INVALID_INPUT', 'automationId is required');
  const base = await baseForAutomation(context.db, automationId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'automation', 'builder'))) {
    return fail('NOT_FOUND', 'Automation not found');
  }
  return ok({
    runs: await context.db.tables.listAutomationRuns(automationId, positiveInt(payload, 'limit') ?? 50),
  });
};

/**
 * May the caller update this row? Built-in roles: editor+ on the table. A
 * scoped role: the row must also be inside its edit rows — probed with a
 * no-op batch validation, which loads the row through the same edit predicate
 * every write uses (anything but `not_found` means the row is editable).
 */
async function editableRecord(
  request: HandlerRequest,
  context: PlatformHandlerContext,
  tableId: number,
  recordId: number,
): Promise<TableDataAccess | undefined> {
  const data = await requireTableData(request, context, tableId, 'update');
  if (!data) return undefined;
  const record = await context.db.tables.getRecord(tableId, recordId, data.scope);
  if (!record) return undefined;
  if (data.scope.kind === 'full') return data;
  const [probe] = await context.db.tables.validateBatchRecords(
    { table_id: tableId, items: [{ record_id: recordId, revision: record.revision, values: {} }] },
    data.scope,
  );
  return probe && !(probe.ok === false && probe.reason === 'not_found') ? data : undefined;
}

const listRecordButtons: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const recordId = positiveInt(payload, 'recordId');
  if (!tableId || !recordId) return fail('INVALID_INPUT', 'tableId and recordId are required');
  const reader = await requireTableData(request, context, tableId, 'read', { allowMaskedValues: true });
  if (!reader || !(await context.db.tables.getRecord(tableId, recordId, reader.scope))) {
    return fail('NOT_FOUND', 'Record not found');
  }
  // Readers who cannot update the row see no buttons (and learn nothing about rules).
  if (!(await editableRecord(request, context, tableId, recordId))) return ok({ buttons: [] });
  return ok({
    buttons: await context.db.tables.listRecordButtons(tableId, recordId, effectiveUserId(request.actor)),
  });
};

const triggerAutomation: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const ruleId = positiveInt(payload, 'ruleId');
  const recordId = positiveInt(payload, 'recordId');
  const requestId = stringValue(payload, 'requestId');
  if (!ruleId || !recordId || !requestId || !REQUEST_ID_PATTERN.test(requestId)) {
    return fail('INVALID_INPUT', 'ruleId, recordId and a requestId (8-100 letters, digits, _ or -) are required');
  }
  const rule = await context.db.tables.getAutomationRule(ruleId);
  const base = rule ? await baseForTable(context.db, rule.table_id) : undefined;
  if (!rule || !base || !(await editableRecord(request, context, rule.table_id, recordId))) {
    return fail('NOT_FOUND', 'Record not found');
  }
  const queued = await context.db.tables.enqueueButtonRun({
    ruleId,
    tableId: rule.table_id,
    recordId,
    actorId: effectiveUserId(request.actor),
    requestId,
  });
  if (!queued.ok) {
    return queued.reason === 'condition_not_met'
      ? fail('CONFLICT', 'This button does not apply to the record any more', { reason: queued.reason })
      : fail('NOT_FOUND', 'Button not found');
  }
  return ok({ queued: true, duplicate: queued.duplicate });
};

export const automationHandlers = {
  listAutomations,
  createAutomation,
  updateAutomation,
  listAutomationRuns,
  deleteAutomation,
  triggerAutomation,
  listRecordButtons,
} satisfies TablesHandlers;
