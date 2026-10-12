/** All three transports dispatch the same guarded AI field actions. */
import { effectiveUserId } from '@greenhouse/platform-kernel';
import { parseTableFieldConfig, usageBudgetAccountId } from '@greenhouse/db';
import type { TableAiFieldStatusView } from '@greenhouse/types/tables';
import { activeUserHasFeature } from '../../../auth/features.js';
import { baseForField, requireBase } from '../access.js';
import { aiFieldAccount } from '../ai-fields.js';
import { fail, ok, payloadOf, positiveInt, type Handler, type TablesHandlers } from './shared.js';

const handle =
  (mode: 'fill' | 'regenerate' | 'status'): Handler =>
  async (request, context) => {
    const payload = payloadOf(request);
    const fieldId = positiveInt(payload, 'fieldId');
    if (!fieldId) return fail('INVALID_INPUT', 'fieldId is required');
    const field = await context.db.tables.getField(fieldId);
    const base = await baseForField(context.db, fieldId);
    if (
      !field ||
      field.archived_at ||
      field.type !== 'ai' ||
      !base ||
      !(await requireBase(context, request.actor, base.id, 'field', mode === 'status' ? 'viewer' : 'builder'))
    )
      return fail('NOT_FOUND', 'Field not found');
    const config = parseTableFieldConfig(field).ai;
    if (!config) return fail('INVALID_INPUT', 'AI configuration is unavailable');
    let recordIds: number[] | undefined;
    if (payload.recordIds !== undefined) {
      if (
        !Array.isArray(payload.recordIds) ||
        payload.recordIds.length > 200 ||
        !payload.recordIds.every((id) => Number.isSafeInteger(id) && id > 0)
      )
        return fail('INVALID_INPUT', 'recordIds must contain at most 200 positive IDs');
      recordIds = [...new Set(payload.recordIds as number[])];
    }
    const accountInput = aiFieldAccount(fieldId, config);
    const account = await context.db.usageBudget.getAccount(usageBudgetAccountId({ ...accountInput, unit: 'tokens' }));
    const tokens = (account?.spent_units ?? 0) + (account?.reserved_units ?? 0);
    const cap = accountInput.limit_units;
    if (mode !== 'status') {
      if (!(await activeUserHasFeature(effectiveUserId(request.actor), 'tables_ai_fields', context.db)))
        return fail('FORBIDDEN', 'AI fields are disabled for this account');
      return ok(
        await context.db.tables.enqueueAiField(fieldId, {
          onlyBlank: mode === 'fill',
          recordIds,
          capReached: tokens >= cap,
        }),
      );
    }
    const jobs = await context.db.tables.aiFieldJobs(fieldId);
    const status: TableAiFieldStatusView = {
      fieldId,
      counts: { queued: 0, running: 0, failed: 0 },
      usage: { tokens, cap },
      records: {},
    };
    for (const job of jobs) {
      if (job.status === 'succeeded' || !job.record_id) continue;
      status.counts[job.status]++;
      if (recordIds?.includes(job.record_id))
        status.records[String(job.record_id)] = { state: job.status, ...(job.error ? { error: job.error } : {}) };
    }
    return ok(status);
  };

export const aiFieldHandlers = {
  fillAiField: handle('fill'),
  regenerateAiField: handle('regenerate'),
  getAiFieldStatus: handle('status'),
} satisfies TablesHandlers;
