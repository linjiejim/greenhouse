/**
 * The minute sweep for time-driven Tables automations (`upkeep-jobs.ts` runs it
 * every minute while `TABLES_AUTOMATION_WORKER` is on). It only enqueues; the
 * worker runs what it queued. Every enqueue is idempotent on its key, so two
 * instances sweeping at once, or a sweep that crashed half way, never run an
 * occurrence twice.
 *
 * - schedule rules (`next_fire_at` due): the latest missed occurrence within
 *   24 h runs once (`scope: 'once'`, key `rule:<id>:schedule:<occurrence>`) or
 *   once per record matching the condition (`scope: 'records'`, ≤ 200, key
 *   `…:<recordId>`); then `next_fire_at` moves past now (CAS on revision).
 * - date rules: records whose date + offset falls in `(swept_until, now]`, key
 *   `rule:<id>:date:<recordId>:<fieldValue>:<offset>` (an edited date fires
 *   again, an unchanged one never). `swept_until` starts at the moment the rule
 *   was created / enabled / re-triggered, so old dates are never fired en masse;
 *   after downtime the window reaches back at most 24 h, like schedules.
 */

import type { DatabaseProvider, TableAutomationRuleRow } from '@greenhouse/db';
import { TABLE_AUTOMATION_LIMITS } from '@greenhouse/types/tables';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { dueOccurrence, SCHEDULE_CATCH_UP_MS } from './automation-schedule.js';

const RULE_PAGE = 100;
const DATE_PAGE = 200;

export interface TablesAutomationSweepResult {
  /** Outbox rows created this pass. */
  enqueued: number;
  rules: number;
}

async function sweepScheduleRule(db: DatabaseProvider, rule: TableAutomationRuleRow, now: Date): Promise<number> {
  const schedule = rule.config.schedule;
  if (!schedule || !rule.next_fire_at) {
    await db.tables.advanceScheduleRule({
      id: rule.id,
      revision: rule.revision,
      expected: rule.next_fire_at,
      next: null,
    });
    return 0;
  }
  const { occurrence, next } = dueOccurrence(schedule, new Date(rule.next_fire_at), now);
  let enqueued = 0;
  if (occurrence) {
    const at = occurrence.toISOString();
    const base = { rule, trigger: 'schedule' as const, scheduledFor: occurrence };
    if (schedule.scope === 'once') {
      const row = await db.tables.enqueueAutomationRun({
        ...base,
        recordId: null,
        key: `rule:${rule.id}:schedule:${at}`,
        payload: { tableId: rule.table_id, occurrence: at },
      });
      if (row) enqueued += 1;
    } else {
      const cap = TABLE_AUTOMATION_LIMITS.scheduleRecords;
      const ids = await db.tables.scheduleRecordIds(rule, { limit: cap + 1, at: now });
      if (ids.length > cap) {
        logger.warn('[tables-automation] a per-record schedule matched more records than it may run', {
          ruleId: rule.id,
          cap,
        });
      }
      for (const recordId of ids.slice(0, cap)) {
        const row = await db.tables.enqueueAutomationRun({
          ...base,
          recordId,
          key: `rule:${rule.id}:schedule:${at}:${recordId}`,
          payload: { tableId: rule.table_id, occurrence: at },
        });
        if (row) enqueued += 1;
      }
    }
  }
  await db.tables.advanceScheduleRule({ id: rule.id, revision: rule.revision, expected: rule.next_fire_at, next });
  return enqueued;
}

async function sweepDateRule(db: DatabaseProvider, rule: TableAutomationRuleRow, now: Date): Promise<number> {
  const trigger = rule.config.dateTrigger;
  if (!rule.swept_until || !trigger) {
    // Never backfill: a rule without a cursor starts sweeping from now.
    await db.tables.advanceDateRule({ id: rule.id, revision: rule.revision, expected: rule.swept_until, next: now });
    return 0;
  }
  const from = new Date(Math.max(Date.parse(rule.swept_until), now.getTime() - SCHEDULE_CATCH_UP_MS));
  if (from.getTime() >= now.getTime()) return 0;
  let enqueued = 0;
  let after: { fireAt: string; id: number } | undefined;
  for (;;) {
    const due = await db.tables.dateReachedRecords(rule, { from, to: now, after, limit: DATE_PAGE });
    for (const record of due) {
      const row = await db.tables.enqueueAutomationRun({
        rule,
        recordId: record.id,
        trigger: 'date_reached',
        key: `rule:${rule.id}:date:${record.id}:${record.value}:${trigger.offsetDays}`,
        scheduledFor: new Date(record.fireAt),
        payload: { tableId: rule.table_id, fieldValue: record.value, fireAt: record.fireAt },
      });
      if (row) enqueued += 1;
    }
    if (due.length < DATE_PAGE) break;
    const last = due[due.length - 1]!;
    after = { fireAt: last.fireAt, id: last.id };
  }
  await db.tables.advanceDateRule({ id: rule.id, revision: rule.revision, expected: rule.swept_until, next: now });
  return enqueued;
}

/** One sweep at `now`. A failing rule is logged and skipped; the others still run. */
export async function sweepTablesAutomations(
  db: DatabaseProvider,
  options: { now?: Date } = {},
): Promise<TablesAutomationSweepResult> {
  const now = options.now ?? new Date();
  let enqueued = 0;
  let rules = 0;
  const attempt = async (rule: TableAutomationRuleRow, sweep: typeof sweepScheduleRule) => {
    rules += 1;
    try {
      enqueued += await sweep(db, rule, now);
    } catch (error) {
      logger.warn('[tables-automation] sweep skipped a rule', { ruleId: rule.id, error: toErrorMessage(error) });
    }
  };
  // Due schedule rules leave the due set as they are advanced; page until none is left.
  const seen = new Set<number>();
  for (;;) {
    const page = (await db.tables.listDueScheduleRules(now, RULE_PAGE)).filter((rule) => !seen.has(rule.id));
    for (const rule of page) {
      seen.add(rule.id);
      await attempt(rule, sweepScheduleRule);
    }
    if (page.length === 0) break;
  }
  for (const rule of await db.tables.listEnabledDateRules()) await attempt(rule, sweepDateRule);
  return { enqueued, rules };
}
