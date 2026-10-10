/**
 * Automation rules and runs — builder work. The async worker, the new
 * triggers, buttons (`triggerAutomation` / `listRecordButtons`), the server-set
 * executor (D17) and `deleteAutomation` arrive with slice Au.
 */

import { effectiveUserId } from '@greenhouse/platform-kernel';
import type { TableAutomationConfig, TableAutomationTrigger } from '@greenhouse/types/tables';
import { baseForAutomation, requireBase } from '../access.js';
import {
  fail,
  notImplemented,
  objectValue,
  ok,
  payloadOf,
  positiveInt,
  stringValue,
  type Handler,
  type TablesHandlers,
} from './shared.js';

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
  const baseId = positiveInt(payload, 'baseId');
  const tableId = positiveInt(payload, 'tableId');
  const name = stringValue(payload, 'name');
  const trigger = stringValue(payload, 'trigger') as TableAutomationTrigger | undefined;
  const config = objectValue<TableAutomationConfig>(payload, 'config');
  if (!baseId || !tableId || !name || !trigger || !config) {
    return fail('INVALID_INPUT', 'baseId, tableId, name, trigger, and config are required');
  }
  if (!(await requireBase(context, request.actor, baseId, 'automation', 'builder'))) {
    return fail('NOT_FOUND', 'Base not found');
  }
  const automation = await context.db.tables.createAutomationRule({
    base_id: baseId,
    table_id: tableId,
    name,
    status: payload.status === 'enabled' ? 'enabled' : 'disabled',
    trigger,
    config,
    execution_user_id: stringValue(payload, 'executionUserId') ?? effectiveUserId(request.actor),
    user_id: effectiveUserId(request.actor),
  });
  return ok({ automation });
};

const updateAutomation: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const automationId = positiveInt(payload, 'automationId');
  const revision = positiveInt(payload, 'revision');
  if (!automationId || !revision) return fail('INVALID_INPUT', 'automationId and revision are required');
  const base = await baseForAutomation(context.db, automationId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'automation', 'builder'))) {
    return fail('NOT_FOUND', 'Automation not found');
  }
  const result = await context.db.tables.updateAutomationRule(automationId, {
    revision,
    name: stringValue(payload, 'name'),
    status: payload.status === 'enabled' || payload.status === 'disabled' ? payload.status : undefined,
    trigger: payload.trigger === 'record_created' || payload.trigger === 'record_updated' ? payload.trigger : undefined,
    config: objectValue<TableAutomationConfig>(payload, 'config'),
    execution_user_id: stringValue(payload, 'executionUserId'),
    user_id: effectiveUserId(request.actor),
  });
  if (result.ok) return ok({ automation: result.value });
  return result.reason === 'conflict'
    ? fail('CONFLICT', 'Automation revision conflict', { currentRevision: result.current })
    : fail('NOT_FOUND', 'Automation not found');
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

export const automationHandlers = {
  listAutomations,
  createAutomation,
  updateAutomation,
  listAutomationRuns,
  // Slice Au.
  deleteAutomation: notImplemented,
  triggerAutomation: notImplemented,
  listRecordButtons: notImplemented,
} satisfies TablesHandlers;
